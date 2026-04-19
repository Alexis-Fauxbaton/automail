import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import { getAuthUrl as getGmailAuthUrl, getConnection, deleteConnection } from "../lib/gmail/auth";
import { getZohoAuthUrl } from "../lib/zoho/auth";
import { processNewEmails, reanalyzeEmail, type ProcessingReport } from "../lib/gmail/pipeline";
import { refineDraft } from "../lib/gmail/refine-draft";
import { AnalysisDisplay } from "../components/SupportAnalysisDisplay";
import type { SupportAnalysisExtended } from "../lib/support/orchestrator";
import type { MailProvider } from "../lib/mail/types";
import prisma from "../db.server";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const connection = await getConnection(shop);

  let emails: SerializedEmail[] = [];
  if (connection) {
    const rows = await prisma.incomingEmail.findMany({
      where: { shop },
      orderBy: { receivedAt: "desc" },
      take: 500,
    });
    emails = rows.map(serializeEmail);
  }

  // Build auth URLs for both providers (only shown when not connected)
  let gmailAuthUrl: string | null = null;
  let zohoAuthUrl: string | null = null;
  if (!connection) {
    try { gmailAuthUrl = getGmailAuthUrl(shop); } catch { /* credentials not configured */ }
    try { zohoAuthUrl = getZohoAuthUrl(shop); } catch { /* credentials not configured */ }
  }

  return {
    connected: !!connection,
    provider: (connection?.provider ?? null) as MailProvider | null,
    connectedEmail: connection?.email ?? null,
    lastSyncAt: connection?.lastSyncAt?.toISOString() ?? null,
    gmailAuthUrl,
    zohoAuthUrl,
    emails,
  };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("_action") ?? "");

  if (intent === "disconnect") {
    await deleteConnection(session.shop);
    return { disconnected: true, report: null, reanalyzed: null, refined: null };
  }

  if (intent === "resync") {
    await prisma.incomingEmail.deleteMany({ where: { shop: session.shop } });
    await prisma.mailConnection.update({
      where: { shop: session.shop },
      data: { historyId: null, lastSyncAt: null },
    });
    const report = await processNewEmails(session.shop, admin);
    const rows = await prisma.incomingEmail.findMany({
      where: { shop: session.shop },
      orderBy: { receivedAt: "desc" },
      take: 500,
    });
    return { report, emails: rows.map(serializeEmail), disconnected: false, reanalyzed: null, refined: null };
  }

  if (intent === "sync") {
    const report = await processNewEmails(session.shop, admin);
    const rows = await prisma.incomingEmail.findMany({
      where: { shop: session.shop },
      orderBy: { receivedAt: "desc" },
      take: 500,
    });
    return { report, emails: rows.map(serializeEmail), disconnected: false, reanalyzed: null, refined: null };
  }

  if (intent === "reanalyze") {
    const emailId = String(formData.get("emailId") ?? "");
    const analysis = await reanalyzeEmail(emailId, admin, session.shop);
    return { reanalyzed: { emailId, analysis }, report: null, disconnected: false, refined: null };
  }

  if (intent === "refine") {
    const emailId = String(formData.get("emailId") ?? "");
    const instructions = String(formData.get("instructions") ?? "");
    const currentDraft = String(formData.get("currentDraft") ?? "");
    const record = await prisma.incomingEmail.findUnique({ where: { id: emailId } });
    if (!record || !currentDraft || !instructions) {
      return { report: null, disconnected: false, reanalyzed: null, refined: null };
    }
    const newDraft = await refineDraft(currentDraft, instructions, {
      subject: record.subject,
      body: record.bodyText,
    });
    let history: string[] = [];
    try { history = JSON.parse(record.draftHistory || "[]"); } catch { /* ignore */ }
    history.push(currentDraft);
    await prisma.incomingEmail.update({
      where: { id: emailId },
      data: { draftReply: newDraft, draftHistory: JSON.stringify(history) },
    });
    return { refined: { emailId, newDraft, draftHistory: history }, report: null, disconnected: false, reanalyzed: null };
  }

  return { report: null, disconnected: false, reanalyzed: null, refined: null };
};

// ---------------------------------------------------------------------------
// Types & serialization
// ---------------------------------------------------------------------------

interface SerializedEmail {
  id: string;
  externalMessageId: string;
  threadId: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  snippet: string;
  bodyText: string;
  receivedAt: string;
  tier1Result: string | null;
  tier2Result: string | null;
  isKnownCustomer: boolean;
  processingStatus: string;
  analysisResult: SupportAnalysisExtended | null;
  draftReply: string | null;
  draftHistory: string[];
  errorMessage: string | null;
}

function serializeEmail(row: {
  id: string;
  externalMessageId: string;
  threadId: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  snippet: string;
  bodyText: string;
  receivedAt: Date;
  tier1Result: string | null;
  tier2Result: string | null;
  isKnownCustomer: boolean;
  processingStatus: string;
  analysisResult: string | null;
  draftReply: string | null;
  draftHistory: string;
  errorMessage: string | null;
}): SerializedEmail {
  let parsed: SupportAnalysisExtended | null = null;
  if (row.analysisResult) {
    try { parsed = JSON.parse(row.analysisResult); } catch { /* ignore */ }
  }
  let history: string[] = [];
  try { history = JSON.parse(row.draftHistory || "[]"); } catch { /* ignore */ }
  return {
    id: row.id,
    externalMessageId: row.externalMessageId,
    threadId: row.threadId,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    subject: row.subject,
    snippet: row.snippet,
    bodyText: row.bodyText,
    receivedAt: row.receivedAt.toISOString(),
    tier1Result: row.tier1Result,
    tier2Result: row.tier2Result,
    isKnownCustomer: row.isKnownCustomer,
    processingStatus: row.processingStatus,
    analysisResult: parsed,
    draftReply: row.draftReply,
    draftHistory: history,
    errorMessage: row.errorMessage,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FilterTab = "all" | "support" | "uncertain" | "filtered";

function getClassification(email: SerializedEmail): FilterTab {
  if (email.tier1Result?.startsWith("filtered:")) return "filtered";
  if (email.tier2Result === "support_client") return "support";
  if (email.tier2Result === "incertain") return "uncertain";
  if (email.tier2Result === "probable_non_client") return "filtered";
  return "all";
}

function filterReason(email: SerializedEmail): string | null {
  if (!email.tier1Result?.startsWith("filtered:")) return null;
  return email.tier1Result.replace("filtered:", "");
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Thread grouping
// ---------------------------------------------------------------------------

interface EmailThread {
  threadId: string;
  emails: SerializedEmail[]; // chronological order (oldest first)
  latest: SerializedEmail;   // most recent email
}

function groupByThread(emails: SerializedEmail[]): EmailThread[] {
  const map = new Map<string, SerializedEmail[]>();
  for (const email of emails) {
    const key = email.threadId || email.id; // fallback to email id if no threadId
    const arr = map.get(key) ?? [];
    arr.push(email);
    map.set(key, arr);
  }
  const threads: EmailThread[] = [];
  for (const [threadId, threadEmails] of map) {
    // Sort chronologically (oldest first)
    threadEmails.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
    const latest = threadEmails[threadEmails.length - 1];
    threads.push({ threadId, emails: threadEmails, latest });
  }
  // Sort threads by latest email (newest thread first)
  threads.sort((a, b) => new Date(b.latest.receivedAt).getTime() - new Date(a.latest.receivedAt).getTime());
  return threads;
}

function getThreadClassification(thread: EmailThread): FilterTab {
  return getClassification(thread.latest);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConnectionCard({
  connected,
  provider,
  connectedEmail,
  lastSyncAt,
  gmailAuthUrl,
  zohoAuthUrl,
  isSyncing,
}: {
  connected: boolean;
  provider: MailProvider | null;
  connectedEmail: string | null;
  lastSyncAt: string | null;
  gmailAuthUrl: string | null;
  zohoAuthUrl: string | null;
  isSyncing: boolean;
}) {
  if (!connected) {
    return (
      <s-box padding="large-500" borderWidth="base" borderRadius="large-200" background="subdued">
        <s-stack direction="block" gap="base" align="center">
          <s-heading>Connect your email</s-heading>
          <s-paragraph>
            Automatically scan your inbox for customer support emails, classify them, and generate draft replies.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            {gmailAuthUrl && (
              <s-link href={gmailAuthUrl}>
                <s-button variant="primary">Connect Gmail</s-button>
              </s-link>
            )}
            {zohoAuthUrl && (
              <s-link href={zohoAuthUrl}>
                <s-button variant="secondary">Connect Zoho Mail</s-button>
              </s-link>
            )}
          </s-stack>
        </s-stack>
      </s-box>
    );
  }

  const providerLabel = provider === "zoho" ? "Zoho Mail" : "Gmail";

  return (
    <s-stack direction="inline" gap="base" align="center" blockAlign="center">
      <s-stack direction="block" gap="small-100" align="start">
        <s-paragraph>
          <strong>{connectedEmail}</strong>
          <s-text tone="subdued"> ({providerLabel})</s-text>
        </s-paragraph>
        {lastSyncAt && (
          <s-text variant="bodySm" tone="subdued">
            Last sync: {relativeTime(lastSyncAt)}
          </s-text>
        )}
      </s-stack>
      <s-stack direction="inline" gap="small-300">
        <Form method="post">
          <input type="hidden" name="_action" value="sync" />
          <s-button variant="primary" type="submit" {...(isSyncing ? { loading: true } : {})}>
            {isSyncing ? "Syncing…" : "Sync now"}
          </s-button>
        </Form>
        <Form method="post">
          <input type="hidden" name="_action" value="resync" />
          <s-button variant="tertiary" type="submit" {...(isSyncing ? { loading: true } : {})}>
            Re-sync all
          </s-button>
        </Form>
        <Form method="post">
          <input type="hidden" name="_action" value="disconnect" />
          <s-button tone="critical" variant="plain" type="submit">
            Disconnect
          </s-button>
        </Form>
      </s-stack>
    </s-stack>
  );
}

function PipelineStats({ emails }: { emails: SerializedEmail[] }) {
  if (emails.length === 0) return null;
  const tier1 = emails.filter((e) => e.tier1Result?.startsWith("filtered:")).length;
  const tier2 = emails.filter((e) => e.tier1Result === "passed" && e.tier2Result).length;
  const tier3 = emails.filter((e) => e.processingStatus === "analyzed").length;

  return (
    <s-stack direction="inline" gap="large-500">
      <s-stack direction="block" gap="small-100" align="center">
        <s-text variant="headingLg">{tier1}</s-text>
        <s-text variant="bodySm" tone="subdued">Tier 1 (free)</s-text>
      </s-stack>
      <s-stack direction="block" gap="small-100" align="center">
        <s-text variant="headingLg">{tier2}</s-text>
        <s-text variant="bodySm" tone="subdued">Tier 2 (LLM)</s-text>
      </s-stack>
      <s-stack direction="block" gap="small-100" align="center">
        <s-text variant="headingLg">{tier3}</s-text>
        <s-text variant="bodySm" tone="subdued">Tier 3 (full)</s-text>
      </s-stack>
      <s-stack direction="block" gap="small-100" align="center">
        <s-text variant="headingLg">{emails.length}</s-text>
        <s-text variant="bodySm" tone="subdued">Total</s-text>
      </s-stack>
    </s-stack>
  );
}

function ThreadCard({
  thread,
  isExpanded,
  onToggle,
}: {
  thread: EmailThread;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { latest, emails } = thread;
  const cls = getThreadClassification(thread);
  const reason = filterReason(latest);
  const messageCount = emails.length;

  const borderColor =
    cls === "support" ? "success" : cls === "uncertain" ? "warning" : undefined;

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      {...(borderColor ? { borderColor } : {})}
    >
      <s-stack direction="block" gap="small-300">
        {/* Row 1: badges */}
        <s-stack direction="inline" gap="small-200">
          {cls === "support" && <s-badge tone="success">Support</s-badge>}
          {cls === "uncertain" && <s-badge tone="warning">Uncertain</s-badge>}
          {cls === "filtered" && <s-badge tone="read-only">Filtered</s-badge>}
          {latest.processingStatus === "error" && <s-badge tone="critical">Error</s-badge>}
          {latest.processingStatus === "analyzed" && <s-badge tone="success">Analyzed</s-badge>}
          {latest.isKnownCustomer && <s-badge tone="info">Customer</s-badge>}
          {messageCount > 1 && <s-badge>{messageCount} messages</s-badge>}
        </s-stack>

        {/* Row 2: sender + time */}
        <s-stack direction="inline" gap="small-300" blockAlign="center">
          <s-paragraph>
            <strong>{latest.fromName || latest.fromAddress}</strong>
            {latest.fromName && (
              <s-text tone="subdued"> {latest.fromAddress}</s-text>
            )}
          </s-paragraph>
          <s-text variant="bodySm" tone="subdued">
            {relativeTime(latest.receivedAt)}
          </s-text>
        </s-stack>

        {/* Row 3: subject + snippet */}
        <s-paragraph>
          <strong>{latest.subject}</strong>
        </s-paragraph>
        {!isExpanded && (
          <s-text variant="bodySm" tone="subdued">
            {latest.snippet.slice(0, 120)}{latest.snippet.length > 120 ? "…" : ""}
          </s-text>
        )}

        {reason && !isExpanded && (
          <s-text variant="bodySm" tone="subdued">
            {reason}
          </s-text>
        )}

        <s-button variant="plain" onClick={onToggle}>
          {isExpanded ? "Collapse" : "Details"}
        </s-button>

        {/* Expanded content */}
        {isExpanded && (
          <s-stack direction="block" gap="base">
            {/* Thread messages */}
            {emails.map((email, idx) => (
              <s-box key={email.id} padding="base" background="subdued" borderRadius="base">
                <s-stack direction="block" gap="small-300">
                  <s-stack direction="inline" gap="small-300" blockAlign="center">
                    <s-text variant="headingSm">
                      {email.fromName || email.fromAddress}
                    </s-text>
                    <s-text variant="bodySm" tone="subdued">
                      {relativeTime(email.receivedAt)}
                    </s-text>
                    {idx === emails.length - 1 && messageCount > 1 && (
                      <s-badge tone="info">Latest</s-badge>
                    )}
                  </s-stack>
                  <s-paragraph>
                    {email.bodyText.length > 1500
                      ? email.bodyText.slice(0, 1500) + "…"
                      : email.bodyText}
                  </s-paragraph>
                </s-stack>
              </s-box>
            ))}

            {reason && (
              <s-banner tone="info">
                Filtered by: {reason}
              </s-banner>
            )}

            {/* Analysis (from latest email only) */}
            {latest.analysisResult && (
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-text variant="headingSm">Analysis</s-text>
                  <AnalysisDisplay analysis={latest.analysisResult} />
                </s-stack>
              </s-box>
            )}

            {/* Draft (from latest email only) */}
            {latest.draftReply && <DraftBlock email={latest} />}

            {/* Error */}
            {latest.errorMessage && (
              <s-banner tone="critical">{latest.errorMessage}</s-banner>
            )}

            {/* Re-analyze (on latest email) */}
            {(latest.tier2Result === "incertain" ||
              latest.processingStatus === "error" ||
              latest.tier2Result === "probable_non_client") && (
              <Form method="post">
                <input type="hidden" name="_action" value="reanalyze" />
                <input type="hidden" name="emailId" value={latest.id} />
                <s-button type="submit">Analyze as support email</s-button>
              </Form>
            )}
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}

function DraftBlock({ email }: { email: SerializedEmail }) {
  const allVersions = [...email.draftHistory, email.draftReply!];
  const [versionIndex, setVersionIndex] = useState(allVersions.length - 1);
  const currentVersion = allVersions[versionIndex] ?? email.draftReply!;
  const isLatest = versionIndex === allVersions.length - 1;
  const total = allVersions.length;

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-300" blockAlign="center">
          <s-text variant="headingSm">Draft reply</s-text>
          {total > 1 && (
            <s-stack direction="inline" gap="small-200" blockAlign="center">
              <s-button
                variant="plain"
                size="small"
                disabled={versionIndex === 0}
                onClick={() => setVersionIndex(Math.max(0, versionIndex - 1))}
              >
                ←
              </s-button>
              <s-text variant="bodySm" tone="subdued">
                v{versionIndex + 1}/{total}{isLatest ? "" : " (old)"}
              </s-text>
              <s-button
                variant="plain"
                size="small"
                disabled={isLatest}
                onClick={() => setVersionIndex(Math.min(total - 1, versionIndex + 1))}
              >
                →
              </s-button>
            </s-stack>
          )}
        </s-stack>

        <s-text-area
          label={isLatest ? "Editable draft" : `Version ${versionIndex + 1} (read-only)`}
          rows={10}
          value={currentVersion}
          readOnly={!isLatest}
        />

        {isLatest && (
          <Form method="post">
            <input type="hidden" name="_action" value="refine" />
            <input type="hidden" name="emailId" value={email.id} />
            <input type="hidden" name="currentDraft" value={currentVersion} />
            <s-stack direction="inline" gap="small-300" blockAlign="end">
              <div style={{ flex: 1 }}>
                <s-text-field
                  label="Refinement instructions"
                  name="instructions"
                  placeholder="e.g. Be more formal, mention refund policy, shorten…"
                />
              </div>
              <s-button type="submit" variant="secondary">
                Refine with AI
              </s-button>
            </s-stack>
          </Form>
        )}
      </s-stack>
    </s-box>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSyncing =
    navigation.state === "submitting" &&
    (navigation.formData?.get("_action") === "sync" ||
      navigation.formData?.get("_action") === "resync");

  const [activeTab, setActiveTab] = useState<FilterTab>("support");
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);

  const emails: SerializedEmail[] =
    (actionData as { emails?: SerializedEmail[] })?.emails ?? loaderData.emails;

  const reanalyzed = actionData?.reanalyzed;
  const refined = (actionData as { refined?: { emailId: string; newDraft: string; draftHistory?: string[] } | null })?.refined;
  const displayEmails = emails.map((e) => {
    if (reanalyzed && e.id === reanalyzed.emailId) {
      return {
        ...e,
        processingStatus: "analyzed",
        tier2Result: "support_client",
        analysisResult: reanalyzed.analysis as SupportAnalysisExtended,
        draftReply: reanalyzed.analysis?.draftReply ?? e.draftReply,
      };
    }
    if (refined && e.id === refined.emailId) {
      return { ...e, draftReply: refined.newDraft, draftHistory: refined.draftHistory ?? e.draftHistory };
    }
    return e;
  });

  const threads = groupByThread(displayEmails);

  const tabCounts = {
    all: threads.length,
    support: threads.filter((t) => getThreadClassification(t) === "support").length,
    uncertain: threads.filter((t) => getThreadClassification(t) === "uncertain").length,
    filtered: threads.filter((t) => getThreadClassification(t) === "filtered").length,
  };

  const filteredThreads =
    activeTab === "all"
      ? threads
      : threads.filter((t) => getThreadClassification(t) === activeTab);

  const report = actionData?.report as ProcessingReport | null;

  if (actionData?.disconnected) {
    return (
      <s-page heading="Email inbox">
        <s-section>
          <s-banner tone="success">
            Email disconnected. Refresh the page to reconnect.
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Email inbox">
      {/* Connection */}
      <s-section>
        <ConnectionCard
          connected={loaderData.connected}
          provider={loaderData.provider}
          connectedEmail={loaderData.connectedEmail}
          lastSyncAt={loaderData.lastSyncAt}
          gmailAuthUrl={loaderData.gmailAuthUrl}
          zohoAuthUrl={loaderData.zohoAuthUrl}
          isSyncing={isSyncing}
        />
      </s-section>

      {/* Sync report */}
      {report && (
        <s-section>
          <s-banner tone="info">
            Synced {report.total} emails: {report.supportClient} support, {report.uncertain} uncertain,{" "}
            {report.filtered + report.nonClient} filtered, {report.errors > 0 ? `${report.errors} errors` : "no errors"}.
          </s-banner>
        </s-section>
      )}

      {/* Email list */}
      {loaderData.connected && (
        <>
          {/* Pipeline stats */}
          <s-section heading="Pipeline overview">
            <PipelineStats emails={displayEmails} />
          </s-section>

          <s-section>
            {/* Tabs */}
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small-300">
                {(["support", "uncertain", "all", "filtered"] as FilterTab[]).map((tab) => (
                  <s-button
                    key={tab}
                    variant={activeTab === tab ? "primary" : "tertiary"}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === "all" ? "All" : tab.charAt(0).toUpperCase() + tab.slice(1)} ({tabCounts[tab]})
                  </s-button>
                ))}
              </s-stack>

              {/* Thread cards */}
              <s-stack direction="block" gap="small-300">
                {filteredThreads.length === 0 && (
                  <s-box padding="large-500" background="subdued" borderRadius="base">
                    <s-paragraph>No emails in this category.</s-paragraph>
                  </s-box>
                )}
                {filteredThreads.map((thread) => (
                  <ThreadCard
                    key={thread.threadId}
                    thread={thread}
                    isExpanded={expandedThreadId === thread.threadId}
                    onToggle={() => setExpandedThreadId(expandedThreadId === thread.threadId ? null : thread.threadId)}
                  />
                ))}
              </s-stack>
            </s-stack>
          </s-section>
        </>
      )}
    </s-page>
  );
}
