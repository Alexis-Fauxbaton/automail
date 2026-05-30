import { redirect, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { authenticate } from "../shopify.server";
import { resolveEntitlements } from "../lib/billing/entitlements";
import prisma from "../db.server";
import {
  handleDisconnect,
  handleToggleAutoSync,
  handleResync,
} from "../lib/support/inbox-actions";
import { getAuthUrl as getGmailAuthUrl } from "../lib/gmail/auth";
import { getZohoAuthUrl } from "../lib/zoho/auth";
import { getAuthUrl as getOutlookAuthUrl } from "../lib/outlook/auth";
import ConnectionCard from "../components/connections/ConnectionCard";
import AddMailboxModal from "../components/connections/AddMailboxModal";
import SoftPauseBanner from "../components/connections/SoftPauseBanner";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const ent = await resolveEntitlements({ shop, admin });

  const connections = await prisma.mailConnection.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });

  const threadCountsRaw = await prisma.thread.groupBy({
    by: ["mailConnectionId"],
    where: { shop },
    _count: { _all: true },
  });
  const threadCountsByMailbox: Record<string, number> = Object.fromEntries(
    threadCountsRaw.map((r) => [r.mailConnectionId, r._count._all]),
  );

  // Generate OAuth start URLs server-side (they embed HMAC-signed state).
  // Null when provider credentials are not configured in env.
  let gmailAuthUrl: string | null = null;
  let outlookAuthUrl: string | null = null;
  let zohoAuthUrl: string | null = null;
  try { gmailAuthUrl = getGmailAuthUrl(shop); } catch { /* provider not configured */ }
  try { outlookAuthUrl = getOutlookAuthUrl(shop); } catch { /* provider not configured */ }
  try { zohoAuthUrl = getZohoAuthUrl(shop); } catch { /* provider not configured */ }

  const pausedCount = connections.filter((c) => !c.autoSyncEnabled).length;

  return {
    connections: connections.map((c) => ({
      ...c,
      // Coerce Date fields to ISO strings for serialisation
      tokenExpiry: c.tokenExpiry.toISOString(),
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      syncCancelledAt: c.syncCancelledAt?.toISOString() ?? null,
      onboardingBackfillDoneAt: c.onboardingBackfillDoneAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    threadCountsByMailbox,
    mailboxStatus: ent.mailboxStatus,
    canConnectMailbox: ent.canConnectMailbox,
    pausedCount,
    gmailAuthUrl,
    outlookAuthUrl,
    zohoAuthUrl,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const mailConnectionId = String(formData.get("mailConnectionId") ?? "");

  if (!mailConnectionId) {
    return new Response(JSON.stringify({ error: "missing_mailConnectionId" }), { status: 400 });
  }

  switch (intent) {
    case "disconnect": {
      const expectedEmail = String(formData.get("confirmEmail") ?? "");
      const conn = await prisma.mailConnection.findUnique({
        where: { id: mailConnectionId, shop },
      });
      if (!conn) {
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }
      if (conn.email !== expectedEmail) {
        return new Response(JSON.stringify({ error: "confirmation_mismatch" }), { status: 400 });
      }
      await handleDisconnect({ shop, mailConnectionId });
      return redirect("/app/connections");
    }
    case "toggleAutoSync": {
      const enable = formData.get("enable") === "true";
      await handleToggleAutoSync({ shop, mailConnectionId, enable });
      return redirect("/app/connections");
    }
    case "resync": {
      await handleResync({ shop, mailConnectionId });
      return redirect("/app/connections");
    }
    case "reauth": {
      const provider = String(formData.get("provider") ?? "");
      // Regenerate a fresh OAuth URL (with a new HMAC-signed state) and
      // redirect the top-frame to it so the merchant re-authorises the
      // existing connection. saveConnection's upsert by (shop, email) will
      // update the existing row's tokens transparently.
      let authUrl: string;
      try {
        if (provider === "gmail") authUrl = getGmailAuthUrl(shop);
        else if (provider === "outlook") authUrl = getOutlookAuthUrl(shop);
        else if (provider === "zoho") authUrl = getZohoAuthUrl(shop);
        else return new Response(JSON.stringify({ error: "unknown_provider" }), { status: 400 });
      } catch {
        return new Response(JSON.stringify({ error: "provider_not_configured" }), { status: 500 });
      }
      // We must respond with a JS redirect so window.top navigates out of
      // the Shopify embedded iframe, just like the inbox does for initial auth.
      return new Response(
        `<!DOCTYPE html><html><body><script>window.top.location.href=${JSON.stringify(authUrl)};</script></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    default:
      return new Response(JSON.stringify({ error: "unknown_intent" }), { status: 400 });
  }
}

export default function ConnectionsPage() {
  const {
    connections,
    threadCountsByMailbox,
    mailboxStatus,
    canConnectMailbox,
    pausedCount,
    gmailAuthUrl,
    outlookAuthUrl,
    zohoAuthUrl,
  } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const [showAdd, setShowAdd] = useState(false);

  const allPaused = pausedCount > 0 && pausedCount === connections.length;

  // While any connection is mid-first-sync (no lastSyncAt, no error), poll the
  // loader every 10 s so the merchant sees the "Sync in progress" badge clear
  // automatically without manual refresh. Stops as soon as everything is
  // either synced or in error.
  const revalidator = useRevalidator();
  const hasPendingFirstSync = connections.some(
    (c) => !c.lastSyncAt && !c.lastSyncError,
  );
  useEffect(() => {
    if (!hasPendingFirstSync) return;
    const interval = setInterval(() => revalidator.revalidate(), 10_000);
    return () => clearInterval(interval);
  }, [hasPendingFirstSync, revalidator]);

  return (
    <div style={{ padding: "2.5rem 1.5rem 4rem", fontFamily: "system-ui, -apple-system, sans-serif", maxWidth: 720, margin: "0 auto", color: "#0f172a" }}>
      {/* Page header */}
      <header style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", color: "#64748b" }}>
              {t("connections.eyebrow")}
            </p>
            <h1 style={{ margin: "6px 0 6px", fontSize: 28, fontWeight: 700, letterSpacing: -0.5 }}>
              {t("connections.title")}
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: "#475569" }}>
              {t("connections.subtitle", {
                used: mailboxStatus.used,
                limit: Number.isFinite(mailboxStatus.limit) ? mailboxStatus.limit : "∞",
              })}
            </p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            style={{
              marginTop: 4,
              padding: "9px 18px",
              borderRadius: 8,
              border: "none",
              background: canConnectMailbox ? "#0f172a" : "#94a3b8",
              color: "#fff",
              fontWeight: 600,
              fontSize: 14,
              cursor: canConnectMailbox ? "pointer" : "not-allowed",
              flexShrink: 0,
            }}
          >
            {t("connections.connectMailbox")}
          </button>
        </div>
      </header>

      {/* Soft-pause banner */}
      {allPaused && (
        <SoftPauseBanner
          pausedCount={pausedCount}
          limit={Number.isFinite(mailboxStatus.limit) ? mailboxStatus.limit : 0}
        />
      )}

      {/* Connection list or empty state */}
      {connections.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "#64748b" }}>
          <p style={{ fontSize: 16, marginBottom: 20 }}>{t("connections.emptyState")}</p>
          <button
            onClick={() => setShowAdd(true)}
            style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#0f172a", color: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer" }}
          >
            {t("connections.connectFirst")}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {connections.map((c) => (
            <ConnectionCard
              key={c.id}
              // Re-hydrate Date fields stripped during serialisation.
              // ConnectionCard (via DisconnectModal) only uses c.email and c.id
              // directly; lastSyncAt is formatted in the card body as a string.
              connection={{
                ...c,
                tokenExpiry: new Date(c.tokenExpiry),
                lastSyncAt: c.lastSyncAt ? new Date(c.lastSyncAt) : null,
                syncCancelledAt: c.syncCancelledAt ? new Date(c.syncCancelledAt) : null,
                onboardingBackfillDoneAt: c.onboardingBackfillDoneAt ? new Date(c.onboardingBackfillDoneAt) : null,
                createdAt: new Date(c.createdAt),
                updatedAt: new Date(c.updatedAt),
              }}
              threadCount={threadCountsByMailbox[c.id] ?? 0}
            />
          ))}
        </div>
      )}

      {/* Add mailbox modal */}
      {showAdd && (
        <AddMailboxModal
          onClose={() => setShowAdd(false)}
          canConnect={canConnectMailbox}
          gmailAuthUrl={gmailAuthUrl}
          outlookAuthUrl={outlookAuthUrl}
          zohoAuthUrl={zohoAuthUrl}
        />
      )}
    </div>
  );
}
