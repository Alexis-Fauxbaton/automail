import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";

import { authenticate } from "../shopify.server";
import { getAuthUrl as getGmailAuthUrl, getConnection, deleteConnection } from "../lib/gmail/auth";
import { getZohoAuthUrl } from "../lib/zoho/auth";
import { processNewEmails, reanalyzeEmail, type ProcessingReport } from "../lib/gmail/pipeline";
import { refineDraft } from "../lib/gmail/refine-draft";
import { runDiagnosis, type DiagnosisReport } from "../lib/gmail/diagnose";
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
    lastSyncError: connection?.lastSyncError ?? null,
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
    return { disconnected: true, report: null, reanalyzed: null, refined: null, stopped: false };
  }

  if (intent === "stop") {
    await prisma.mailConnection.update({
      where: { shop: session.shop },
      data: { syncCancelledAt: new Date() },
    });
    return { stopped: true, report: null, disconnected: false, reanalyzed: null, refined: null };
  }

  if (intent === "resync") {
    await prisma.incomingEmail.deleteMany({ where: { shop: session.shop } });
    await prisma.mailConnection.update({
      where: { shop: session.shop },
      data: { historyId: null, lastSyncAt: null },
    });
    // Fire and forget — avoids Cloudflare 524 timeout on large mailboxes.
    processNewEmails(session.shop, admin).catch((err) =>
      console.error("[inbox/resync] background error:", err),
    );
    return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
  }

  if (intent === "sync") {
    // Fire and forget — avoids Cloudflare 524 timeout on large mailboxes.
    processNewEmails(session.shop, admin).catch((err) =>
      console.error("[inbox/sync] background error:", err),
    );
    return { syncStarted: true, report: null, disconnected: false, reanalyzed: null, refined: null, stopped: false };
  }

  if (intent === "diagnose") {
    const diagnosis = await runDiagnosis(session.shop);
    return { diagnosis, report: null, disconnected: false, reanalyzed: null, refined: null };
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
    }, {
      shop: session.shop,
      emailId: emailId,
      threadId: record.threadId,
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

function getMessageDirection(
  email: SerializedEmail,
  connectedEmail: string | null,
): "incoming" | "outgoing" | "unknown" {
  const from = email.fromAddress.trim().toLowerCase();
  const mailbox = (connectedEmail ?? "").trim().toLowerCase();
  if (!from || !mailbox) return "unknown";
  return from === mailbox ? "outgoing" : "incoming";
}

function threadNeedsReply(
  thread: EmailThread,
  connectedEmail: string | null,
): boolean {
  const latestDirection = getMessageDirection(thread.latest, connectedEmail);
  const noReplyNeeded = thread.latest.analysisResult?.conversation?.noReplyNeeded === true;
  const isSupport = getThreadClassification(thread) === "support";
  return isSupport && latestDirection === "incoming" && !noReplyNeeded;
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
  // Primary grouping by threadId
  const map = new Map<string, SerializedEmail[]>();
  for (const email of emails) {
    const key = email.threadId || email.id;
    const arr = map.get(key) ?? [];
    arr.push(email);
    map.set(key, arr);
  }

  // Merge threads that share the same externalMessageId records (Zoho splits
  // threads when the subject changes mid-conversation — same emails appear
  // under multiple threadIds). We deduplicate by externalMessageId and keep
  // the earliest-seen threadId as the canonical key.
  const seenMsgIds = new Map<string, string>(); // externalMessageId → canonical threadId
  const merged = new Map<string, SerializedEmail[]>();

  for (const [threadId, threadEmails] of map) {
    // Find which canonical threadId this group belongs to
    let canonicalId = threadId;
    for (const e of threadEmails) {
      const existing = seenMsgIds.get(e.externalMessageId);
      if (existing) { canonicalId = existing; break; }
    }
    const target = merged.get(canonicalId) ?? [];
    for (const e of threadEmails) {
      if (!target.find((t) => t.externalMessageId === e.externalMessageId)) {
        target.push(e);
        seenMsgIds.set(e.externalMessageId, canonicalId);
      }
    }
    merged.set(canonicalId, target);
  }

  const threads: EmailThread[] = [];
  for (const [threadId, threadEmails] of merged) {
    threadEmails.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
    const latest = threadEmails[threadEmails.length - 1];
    threads.push({ threadId, emails: threadEmails, latest });
  }
  threads.sort((a, b) => new Date(b.latest.receivedAt).getTime() - new Date(a.latest.receivedAt).getTime());
  return threads;
}

function getThreadClassification(thread: EmailThread): FilterTab {
  // Use the latest email that has actually been classified to avoid outgoing
  // messages (which have no tier results) from overriding the thread category.
  const classified = [...thread.emails]
    .reverse()
    .find((e) => e.tier1Result || e.tier2Result);
  return getClassification(classified ?? thread.latest);
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
          <input type="hidden" name="_action" value="diagnose" />
          <s-button variant="tertiary" type="submit">
            Diagnose
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
  connectedEmail,
  onToggle,
}: {
  thread: EmailThread;
  isExpanded: boolean;
  connectedEmail: string | null;
  onToggle: () => void;
}) {
  const { latest, emails } = thread;
  const cls = getThreadClassification(thread);
  const reason = filterReason(latest);
  const messageCount = emails.length;
  const latestDirection = getMessageDirection(latest, connectedEmail);
  const noReplyNeeded = latest.analysisResult?.conversation?.noReplyNeeded === true;
  const requiresReply = threadNeedsReply(thread, connectedEmail);

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
          <s-badge tone={latestDirection === "incoming" ? "info" : "read-only"}>
            Last: {latestDirection}
          </s-badge>
          {requiresReply && <s-badge tone="critical">To process</s-badge>}
          {noReplyNeeded && <s-badge tone="success">No reply needed</s-badge>}
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
                    <s-badge tone={getMessageDirection(email, connectedEmail) === "outgoing" ? "read-only" : "info"}>
                      {getMessageDirection(email, connectedEmail)}
                    </s-badge>
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
            {latest.draftReply && !noReplyNeeded && <DraftBlock email={latest} />}

            {noReplyNeeded && (
              <s-banner tone="info">
                No draft generated: latest customer message appears to close the loop.
              </s-banner>
            )}

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

function DiagnosisView({ diagnosis }: { diagnosis: DiagnosisReport }) {
  return (
    <s-stack direction="block" gap="base">
      <s-paragraph>
        <strong>Provider:</strong> {diagnosis.provider} — <strong>Mailbox:</strong> {diagnosis.connectedEmail}
      </s-paragraph>

      <s-stack direction="block" gap="small-200">
        {diagnosis.steps.map((s, i) => (
          <s-box
            key={i}
            padding="small-300"
            borderWidth="base"
            borderRadius="base"
            {...(s.ok ? {} : { borderColor: "critical" })}
          >
            <s-stack direction="inline" gap="small-300" blockAlign="center">
              <s-badge tone={s.ok ? "success" : "critical"}>{s.ok ? "OK" : "FAIL"}</s-badge>
              <s-text variant="bodySm"><strong>{s.step}:</strong> {s.detail}</s-text>
            </s-stack>
          </s-box>
        ))}
      </s-stack>

      {diagnosis.zohoFolders && diagnosis.zohoFolders.length > 0 && (
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-text variant="headingSm">Zoho folders found</s-text>
            {diagnosis.zohoFolders.map((f) => (
              <s-text key={f.folderId} variant="bodySm">
                <strong>{f.folderName}</strong> — type=<code>{f.folderType || "(empty)"}</code> id={f.folderId}
              </s-text>
            ))}
          </s-stack>
        </s-box>
      )}

      {diagnosis.sampleMessages && diagnosis.sampleMessages.length > 0 && (
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-200">
            <s-text variant="headingSm">Sample messages (first 10)</s-text>
            {diagnosis.sampleMessages.map((m) => (
              <s-box
                key={m.id}
                padding="small-200"
                borderWidth="base"
                borderRadius="base"
                {...(m.detectedOutgoing ? { borderColor: "success" } : {})}
              >
                <s-stack direction="block" gap="small-100">
                  <s-stack direction="inline" gap="small-200" blockAlign="center">
                    <s-badge tone={m.detectedOutgoing ? "success" : "read-only"}>
                      {m.detectedOutgoing ? "OUTGOING" : "incoming"}
                    </s-badge>
                    <s-text variant="bodySm"><strong>from:</strong> {m.from}</s-text>
                  </s-stack>
                  <s-text variant="bodySm">labels: [{m.labelIds.join(", ") || "none"}]</s-text>
                  <s-text variant="bodySm" tone="subdued">{m.subject}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-box>
      )}
    </s-stack>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isSyncing =
    navigation.state === "submitting" &&
    (navigation.formData?.get("_action") === "sync" ||
      navigation.formData?.get("_action") === "resync");

  const syncStarted = (actionData as { syncStarted?: boolean } | null)?.syncStarted === true;
  const syncStopped = (actionData as { stopped?: boolean } | null)?.stopped === true;

  // Keep background-sync state alive across revalidations (actionData resets each time).
  const [bgSyncActive, setBgSyncActive] = useState(false);
  const [syncCancelled, setSyncCancelled] = useState(false);
  const [bgSyncStart, setBgSyncStart] = useState<number>(0);
  const [elapsed, setElapsed] = useState(0);       // seconds since sync started
  const [nextRefresh, setNextRefresh] = useState(8); // seconds until next auto-refresh
  const POLL_INTERVAL = 8;
  const MAX_DURATION = 3 * 60; // 3 minutes

  // Start the background sync indicator when the action returns syncStarted.
  useEffect(() => {
    if (!syncStarted) return;
    setBgSyncActive(true);
    setSyncCancelled(false);
    setBgSyncStart(Date.now());
    setElapsed(0);
    setNextRefresh(POLL_INTERVAL);
  }, [syncStarted]);

  // Stop the background sync indicator when the action returns stopped.
  useEffect(() => {
    if (!syncStopped) return;
    setBgSyncActive(false);
    setSyncCancelled(true);
  }, [syncStopped]);

  // Auto-revalidate every 8 s while a background sync is running.
  useEffect(() => {
    if (!bgSyncActive) return;
    const poll = setInterval(() => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
        setNextRefresh(POLL_INTERVAL);
      }
    }, POLL_INTERVAL * 1_000);
    const stop = setTimeout(() => {
      clearInterval(poll);
      setBgSyncActive(false);
    }, MAX_DURATION * 1_000);
    return () => { clearInterval(poll); clearTimeout(stop); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgSyncActive]);

  // 1-second tick for the elapsed / countdown display.
  useEffect(() => {
    if (!bgSyncActive) return;
    const tick = setInterval(() => {
      const secs = Math.floor((Date.now() - bgSyncStart) / 1_000);
      setElapsed(secs);
      const remaining = POLL_INTERVAL - (secs % POLL_INTERVAL);
      setNextRefresh(remaining === 0 ? POLL_INTERVAL : remaining);
      if (secs >= MAX_DURATION) setBgSyncActive(false);
    }, 1_000);
    return () => clearInterval(tick);
  }, [bgSyncActive, bgSyncStart]);

  // Progress 0-100 over the full 3-minute window (used for bar width).
  const syncProgress = bgSyncActive
    ? Math.min(100, Math.round((elapsed / MAX_DURATION) * 100))
    : 0;

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
  const isPolling = bgSyncActive && revalidator.state !== "idle";

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

      {/* Sync error — persisted in DB, visible after page revalidation */}
      {loaderData.lastSyncError && !bgSyncActive && (
        <s-section>
          <s-banner tone="critical">
            <s-stack direction="block" gap="small-200">
              <s-text variant="headingSm">Erreur de synchronisation</s-text>
              <s-text variant="bodySm">{loaderData.lastSyncError}</s-text>
            </s-stack>
          </s-banner>
        </s-section>
      )}

      {/* Diagnosis report */}
      {(actionData as { diagnosis?: DiagnosisReport })?.diagnosis && (
        <s-section heading="Diagnosis">
          <DiagnosisView diagnosis={(actionData as { diagnosis: DiagnosisReport }).diagnosis} />
        </s-section>
      )}

      {/* Sync cancelled banner */}
      {syncCancelled && !bgSyncActive && (
        <s-section>
          <s-banner tone="warning">
            Sync annulé.
          </s-banner>
        </s-section>
      )}

      {/* Background sync progress bar */}
      {bgSyncActive && (
        <s-section>
          <div style={{
            background: "var(--p-color-bg-surface-secondary, #f1f1f1)",
            borderRadius: "8px",
            overflow: "hidden",
            height: "8px",
            width: "100%",
            marginBottom: "8px",
          }}>
            <div style={{
              height: "100%",
              width: `${syncProgress}%`,
              background: "var(--p-color-bg-fill-brand, #008060)",
              transition: "width 1s linear",
              // Animated shimmer on top
              backgroundImage: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.35) 50%, transparent 100%)",
              backgroundSize: "200% 100%",
              animation: "shimmer 1.5s infinite",
            }} />
          </div>
          <style>{`@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }`}</style>
          <s-stack direction="inline" gap="small-300" blockAlign="center">
            <s-spinner size="small" />
            <s-text variant="bodySm" tone="subdued">
              Sync en cours… {elapsed}s écoulées
              {isPolling ? " — chargement…" : ` — prochain rafraîchissement dans ${nextRefresh}s`}
            </s-text>
            <Form method="post">
              <input type="hidden" name="_action" value="stop" />
              <s-button tone="critical" variant="secondary" type="submit" size="slim">
                Stopper
              </s-button>
            </Form>
          </s-stack>
        </s-section>
      )}
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
                    connectedEmail={loaderData.connectedEmail}
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
