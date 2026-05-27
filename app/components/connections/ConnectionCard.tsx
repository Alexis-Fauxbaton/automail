import { Form } from "react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MailConnection } from "@prisma/client";
import DisconnectModal from "./DisconnectModal";

export default function ConnectionCard(props: {
  connection: MailConnection;
  threadCount: number;
}) {
  const { connection, threadCount } = props;
  const { t } = useTranslation();
  const [showDisconnect, setShowDisconnect] = useState(false);

  const status = computeStatus(connection);

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        padding: "18px 20px",
        background: "#fff",
        boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
      }}
    >
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: providerBg(connection.provider),
            color: "#fff",
            fontWeight: 700,
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          {providerIcon(connection.provider)}
        </span>
        <span style={{ fontWeight: 600, fontSize: 15, color: "#0f172a", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {connection.email}
        </span>
        <StatusPill status={status} />
      </div>

      {/* Meta */}
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14, display: "flex", flexDirection: "column", gap: 3 }}>
        {connection.lastSyncAt && (
          <span>
            {t("connections.lastSyncAt", {
              date: formatDate(connection.lastSyncAt),
            })}
          </span>
        )}
        {connection.lastSyncError && (
          <span style={{ color: "#b91c1c" }}>{connection.lastSyncError}</span>
        )}
        <span>
          {t("connections.threadCount", { count: threadCount })}
        </span>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {connection.lastSyncError && (
          <Form method="post">
            <input type="hidden" name="intent" value="reauth" />
            <input type="hidden" name="mailConnectionId" value={connection.id} />
            <input type="hidden" name="provider" value={connection.provider} />
            <ActionButton type="submit" variant="warning">
              {t("connections.reauth")}
            </ActionButton>
          </Form>
        )}
        <Form method="post">
          <input type="hidden" name="intent" value="toggleAutoSync" />
          <input type="hidden" name="mailConnectionId" value={connection.id} />
          <input type="hidden" name="enable" value={connection.autoSyncEnabled ? "false" : "true"} />
          <ActionButton type="submit" variant="secondary">
            {connection.autoSyncEnabled ? t("connections.pause") : t("connections.resume")}
          </ActionButton>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="resync" />
          <input type="hidden" name="mailConnectionId" value={connection.id} />
          <ActionButton type="submit" variant="secondary">
            {t("connections.resync")}
          </ActionButton>
        </Form>
        <ActionButton type="button" variant="danger" onClick={() => setShowDisconnect(true)}>
          {t("connections.disconnect")}
        </ActionButton>
      </div>

      {showDisconnect && (
        <DisconnectModal
          connection={connection}
          threadCount={threadCount}
          onClose={() => setShowDisconnect(false)}
        />
      )}
    </div>
  );
}

function computeStatus(c: MailConnection): "ok" | "paused" | "error" {
  if (c.lastSyncError) return "error";
  if (!c.autoSyncEnabled) return "paused";
  return "ok";
}

function providerIcon(provider: string): string {
  switch (provider) {
    case "gmail": return "G";
    case "outlook": return "O";
    case "zoho": return "Z";
    default: return "?";
  }
}

// Deterministic date formatter — same output on server and client to avoid
// React hydration mismatch (toLocaleString depends on the runtime timezone).
function formatDate(input: Date | string): string {
  const d = typeof input === "string" ? new Date(input) : input;
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Paris",
  }).format(d);
}

function providerBg(provider: string): string {
  switch (provider) {
    case "gmail": return "#ea4335";
    case "outlook": return "#0078d4";
    case "zoho": return "#e42527";
    default: return "#64748b";
  }
}

function StatusPill({ status }: { status: "ok" | "paused" | "error" }) {
  const { t } = useTranslation();
  const label =
    status === "ok" ? t("connections.statusOk") :
    status === "paused" ? t("connections.statusPaused") :
    t("connections.statusError");
  const colors: Record<string, { bg: string; color: string }> = {
    ok: { bg: "#dcfce7", color: "#15803d" },
    paused: { bg: "#fef9c3", color: "#854d0e" },
    error: { bg: "#fef2f2", color: "#b91c1c" },
  };
  const { bg, color } = colors[status];
  return (
    <span style={{ fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: bg, color }}>
      {label}
    </span>
  );
}

function ActionButton(props: {
  type: "button" | "submit";
  variant: "secondary" | "danger" | "warning";
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const { type, variant, onClick, children } = props;
  const styles: Record<string, React.CSSProperties> = {
    secondary: { background: "#fff", border: "1px solid #cbd5e1", color: "#334155" },
    danger: { background: "#fff", border: "1px solid #fca5a5", color: "#b91c1c" },
    warning: { background: "#fff", border: "1px solid #fde68a", color: "#92400e" },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      style={{
        padding: "6px 14px",
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        cursor: "pointer",
        ...styles[variant],
      }}
    >
      {children}
    </button>
  );
}
