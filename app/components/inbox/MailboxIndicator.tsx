import { Link } from "react-router";
import { useTranslation } from "react-i18next";

export default function MailboxIndicator(props: {
  connections: { id: string; lastSyncError: string | null }[];
}) {
  const { connections } = props;
  const { t } = useTranslation();
  if (connections.length <= 1) return null;

  const errorCount = connections.filter((c) => c.lastSyncError).length;

  return (
    <Link
      to="/app/connections"
      className="mailbox-indicator"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        color: errorCount > 0
          ? "var(--p-color-text-critical, #d82c0d)"
          : "var(--p-color-text-subdued, #6d7175)",
        textDecoration: "none",
        padding: "4px 8px",
        borderRadius: 6,
        border: "1px solid var(--p-color-border, #d0d0d0)",
        background: "white",
      }}
    >
      📥 {t("inbox.mailboxCount", { count: connections.length })}
      {errorCount > 0 && (
        <span style={{ color: "var(--p-color-text-critical, #d82c0d)" }}>
          · {t("inbox.errorCount", { count: errorCount })}
        </span>
      )}
      <span>→</span>
    </Link>
  );
}
