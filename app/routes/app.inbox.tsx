import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import { getAuthUrl, getConnection, deleteConnection } from "../lib/gmail/auth";
import { processNewEmails, reanalyzeEmail, type ProcessingReport } from "../lib/gmail/pipeline";
import { AnalysisDisplay } from "../components/SupportAnalysisDisplay";
import type { SupportAnalysisExtended } from "../lib/support/orchestrator";
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

  const authUrl = connection ? null : getAuthUrl(shop);

  return {
    connected: !!connection,
    googleEmail: connection?.googleEmail ?? null,
    lastSyncAt: connection?.lastSyncAt?.toISOString() ?? null,
    authUrl,
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
    return { disconnected: true, report: null, reanalyzed: null };
  }

  if (intent === "resync") {
    // Dev only: wipe all emails and historyId, then re-fetch everything
    await prisma.incomingEmail.deleteMany({ where: { shop: session.shop } });
    await prisma.gmailConnection.update({
      where: { shop: session.shop },
      data: { historyId: null, lastSyncAt: null },
    });
    const report = await processNewEmails(session.shop, admin);
    const rows = await prisma.incomingEmail.findMany({
      where: { shop: session.shop },
      orderBy: { receivedAt: "desc" },
      take: 500,
    });
    return {
      report,
      emails: rows.map(serializeEmail),
      disconnected: false,
      reanalyzed: null,
    };
  }

  if (intent === "sync") {
    const report = await processNewEmails(session.shop, admin);
    // Return updated email list
    const rows = await prisma.incomingEmail.findMany({
      where: { shop: session.shop },
      orderBy: { receivedAt: "desc" },
      take: 500,
    });
    return {
      report,
      emails: rows.map(serializeEmail),
      disconnected: false,
      reanalyzed: null,
    };
  }

  if (intent === "reanalyze") {
    const emailId = String(formData.get("emailId") ?? "");
    const analysis = await reanalyzeEmail(emailId, admin, session.shop);
    return { reanalyzed: { emailId, analysis }, report: null, disconnected: false };
  }

  return { report: null, disconnected: false, reanalyzed: null };
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SerializedEmail {
  id: string;
  gmailMessageId: string;
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
  errorMessage: string | null;
}

function serializeEmail(row: {
  id: string;
  gmailMessageId: string;
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
  errorMessage: string | null;
}): SerializedEmail {
  let parsed: SupportAnalysisExtended | null = null;
  if (row.analysisResult) {
    try {
      parsed = JSON.parse(row.analysisResult);
    } catch { /* ignore */ }
  }
  return {
    id: row.id,
    gmailMessageId: row.gmailMessageId,
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
    errorMessage: row.errorMessage,
  };
}

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------

type FilterTab = "all" | "support" | "uncertain" | "filtered";

function getClassification(email: SerializedEmail): FilterTab {
  if (email.tier1Result?.startsWith("filtered:")) return "filtered";
  if (email.tier2Result === "support_client") return "support";
  if (email.tier2Result === "incertain") return "uncertain";
  if (email.tier2Result === "probable_non_client") return "filtered";
  return "all";
}

function classificationBadge(email: SerializedEmail) {
  const cls = getClassification(email);
  if (cls === "support")
    return <s-badge tone="success">Support</s-badge>;
  if (cls === "uncertain")
    return <s-badge tone="warning">Uncertain</s-badge>;
  if (cls === "filtered")
    return <s-badge tone="read-only">Filtered</s-badge>;
  if (email.processingStatus === "error")
    return <s-badge tone="critical">Error</s-badge>;
  return <s-badge>Pending</s-badge>;
}

function statusBadge(email: SerializedEmail) {
  if (email.processingStatus === "analyzed")
    return <s-badge tone="success">Analyzed</s-badge>;
  if (email.processingStatus === "error")
    return <s-badge tone="critical">Error</s-badge>;
  return null;
}

function tierBadge(email: SerializedEmail) {
  if (email.tier1Result?.startsWith("filtered:"))
    return <s-badge tone="read-only">Tier 1</s-badge>;
  if (email.tier2Result)
    return <s-badge tone="info">Tier 2 (LLM)</s-badge>;
  if (email.processingStatus === "analyzed")
    return <s-badge tone="success">Tier 3 (full)</s-badge>;
  return null;
}

function filterReason(email: SerializedEmail): string | null {
  if (!email.tier1Result?.startsWith("filtered:")) return null;
  return email.tier1Result.replace("filtered:", "");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function GmailPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSyncing =
    navigation.state === "submitting" &&
    (navigation.formData?.get("_action") === "sync" ||
      navigation.formData?.get("_action") === "resync");

  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Use updated emails from action if available, otherwise from loader
  const emails: SerializedEmail[] =
    (actionData as { emails?: SerializedEmail[] })?.emails ?? loaderData.emails;

  // Apply reanalyze updates
  const reanalyzed = actionData?.reanalyzed;
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
    return e;
  });

  const filteredEmails =
    activeTab === "all"
      ? displayEmails
      : displayEmails.filter((e) => getClassification(e) === activeTab);

  const report = actionData?.report as ProcessingReport | null;

  if (actionData?.disconnected) {
    return (
      <s-page heading="Gmail inbox">
        <s-section>
          <s-banner tone="success">
            Gmail disconnected. Refresh the page to reconnect.
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Gmail inbox">
      {/* Connection section */}
      <s-section heading="Connection">
        {!loaderData.connected ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Connect your Gmail account to automatically scan incoming emails
              for customer support requests.
            </s-paragraph>
            {loaderData.authUrl && (
              <s-link href={loaderData.authUrl}>
                <s-button>Connect Gmail</s-button>
              </s-link>
            )}
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Connected as <strong>{loaderData.googleEmail}</strong>
              {loaderData.lastSyncAt && (
                <> · Last sync: {new Date(loaderData.lastSyncAt).toLocaleString()}</>
              )}
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <Form method="post">
                <input type="hidden" name="_action" value="sync" />
                <s-button type="submit" {...(isSyncing ? { loading: true } : {})}>
                  {isSyncing ? "Syncing…" : "Sync now"}
                </s-button>
              </Form>
              <Form method="post">
                <input type="hidden" name="_action" value="disconnect" />
                <s-button tone="critical" variant="plain" type="submit">
                  Disconnect
                </s-button>
              </Form>
              <Form method="post">
                <input type="hidden" name="_action" value="resync" />
                <s-button variant="plain" type="submit" {...(isSyncing ? { loading: true } : {})}>
                  {isSyncing ? "Re-syncing…" : "Re-sync all (dev)"}
                </s-button>
              </Form>
            </s-stack>
          </s-stack>
        )}
      </s-section>

      {/* Sync report */}
      {report && (
        <s-section>
          <s-banner tone="info">
            Sync complete: {report.total} emails found, {report.alreadyProcessed} already processed,{" "}
            {report.supportClient} support, {report.uncertain} uncertain, {report.filtered} filtered,{" "}
            {report.nonClient} non-client, {report.errors} errors.
          </s-banner>
        </s-section>
      )}

      {/* Email list */}
      {loaderData.connected && (
        <s-section heading="Emails">
          {/* Pipeline stats */}
          {displayEmails.length > 0 && (() => {
            const tier1Filtered = displayEmails.filter(e => e.tier1Result?.startsWith("filtered:")).length;
            const tier2Total = displayEmails.filter(e => e.tier1Result === "passed" && e.tier2Result).length;
            const tier3Total = displayEmails.filter(e => e.processingStatus === "analyzed").length;
            return (
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-paragraph>
                  <strong>Pipeline stats:</strong>{" "}
                  {tier1Filtered} filtered at Tier 1 (free) · {tier2Total} sent to Tier 2 (LLM) · {tier3Total} fully analyzed (Tier 3)
                </s-paragraph>
              </s-box>
            );
          })()}

          {/* Filter tabs */}
          <s-stack direction="inline" gap="small-300">
            {(["all", "support", "uncertain", "filtered"] as FilterTab[]).map(
              (tab) => {
                const count =
                  tab === "all"
                    ? displayEmails.length
                    : displayEmails.filter((e) => getClassification(e) === tab).length;
                return (
                  <s-button
                    key={tab}
                    variant={activeTab === tab ? "primary" : "secondary"}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)} ({count})
                  </s-button>
                );
              },
            )}
          </s-stack>

          {/* Email rows */}
          <s-stack direction="block" gap="base">
            {filteredEmails.length === 0 && (
              <s-paragraph>No emails in this category.</s-paragraph>
            )}
            {filteredEmails.map((email) => (
              <s-box
                key={email.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small-300">
                  {/* Header row */}
                  <s-stack direction="inline" gap="small-300">
                    {classificationBadge(email)}
                    {tierBadge(email)}
                    {statusBadge(email)}
                    {email.isKnownCustomer && (
                      <s-badge tone="info">Shopify customer</s-badge>
                    )}
                  </s-stack>

                  <s-paragraph>
                    <strong>{email.fromName || email.fromAddress}</strong>
                    {email.fromName && (
                      <> &lt;{email.fromAddress}&gt;</>
                    )}
                    {" · "}
                    {new Date(email.receivedAt).toLocaleString()}
                  </s-paragraph>

                  <s-paragraph>
                    <strong>{email.subject}</strong>
                  </s-paragraph>

                  {filterReason(email) && (
                    <s-paragraph>
                      <s-text variant="bodyMd" tone="subdued">
                        Filtered: {filterReason(email)}
                      </s-text>
                    </s-paragraph>
                  )}

                  {/* Expand/collapse */}
                  <s-button
                    variant="plain"
                    onClick={() =>
                      setExpandedId(expandedId === email.id ? null : email.id)
                    }
                  >
                    {expandedId === email.id ? "Collapse" : "Details"}
                  </s-button>

                  {expandedId === email.id && (
                    <s-stack direction="block" gap="base">
                      {/* Email body preview */}
                      <s-box
                        padding="base"
                        background="subdued"
                        borderRadius="base"
                      >
                        <s-paragraph>
                          {email.bodyText.length > 1000
                            ? email.bodyText.slice(0, 1000) + "…"
                            : email.bodyText}
                        </s-paragraph>
                      </s-box>

                      {/* Analysis results */}
                      {email.analysisResult && (
                        <>
                          <s-heading>Analysis</s-heading>
                          <AnalysisDisplay analysis={email.analysisResult} />
                        </>
                      )}

                      {/* Draft reply */}
                      {email.draftReply && (
                        <>
                          <s-heading>Draft reply</s-heading>
                          <s-text-area
                            label="Draft (edit before sending)"
                            rows={10}
                            defaultValue={email.draftReply}
                          />
                        </>
                      )}

                      {/* Error */}
                      {email.errorMessage && (
                        <s-banner tone="critical">{email.errorMessage}</s-banner>
                      )}

                      {/* Re-analyze button for uncertain or errored emails */}
                      {(email.tier2Result === "incertain" ||
                        email.processingStatus === "error" ||
                        email.tier2Result === "probable_non_client") && (
                        <Form method="post">
                          <input type="hidden" name="_action" value="reanalyze" />
                          <input type="hidden" name="emailId" value={email.id} />
                          <s-button type="submit">Analyze as support email</s-button>
                        </Form>
                      )}
                    </s-stack>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
