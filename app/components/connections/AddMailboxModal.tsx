import { useTranslation } from "react-i18next";
import ProviderLogo, { type Provider } from "./ProviderLogo";

export default function AddMailboxModal(props: {
  onClose: () => void;
  canConnect: boolean;
  gmailAuthUrl: string | null;
  outlookAuthUrl: string | null;
  zohoAuthUrl: string | null;
}) {
  const { onClose, canConnect, gmailAuthUrl, outlookAuthUrl, zohoAuthUrl } = props;
  const { t } = useTranslation();

  if (!canConnect) {
    return (
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
        onClick={onClose}
      >
        <div
          style={{ background: "#fff", borderRadius: 12, padding: "28px 28px 24px", maxWidth: 400, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.18)", textAlign: "center" }}
          onClick={(e) => e.stopPropagation()}
        >
          <h2 style={{ margin: "0 0 12px", fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
            {t("connections.limitReachedTitle")}
          </h2>
          <p style={{ margin: "0 0 20px", fontSize: 14, color: "#475569" }}>
            {t("connections.limitReachedBody")}
          </p>
          <a
            href="/app/billing"
            style={{
              display: "inline-block",
              padding: "9px 20px",
              borderRadius: 7,
              background: "#0f172a",
              color: "#fff",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {t("connections.upgradeCta")}
          </a>
        </div>
      </div>
    );
  }

  const providers: Array<{ label: string; provider: Provider; url: string | null }> = [
    { label: "Gmail", provider: "gmail", url: gmailAuthUrl },
    { label: "Outlook", provider: "outlook", url: outlookAuthUrl },
    { label: "Zoho Mail", provider: "zoho", url: zohoAuthUrl },
  ];

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        style={{ background: "#fff", borderRadius: 12, padding: "28px 28px 24px", maxWidth: 400, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 20px", fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
          {t("connections.pickProvider")}
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          {providers.map(({ label, provider, url }) => (
            url ? (
              <a
                key={label}
                href={url}
                onClick={() => {
                  // Must navigate top-frame to escape Shopify's embedded iframe
                  if (typeof window !== "undefined" && window.top) {
                    window.top.location.href = url;
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 16px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  textDecoration: "none",
                  color: "#0f172a",
                  fontWeight: 500,
                  fontSize: 15,
                  transition: "background 0.15s",
                }}
              >
                <span style={{ display: "inline-flex", flexShrink: 0 }}>
                  <ProviderLogo provider={provider} size={32} />
                </span>
                {label}
              </a>
            ) : null
          ))}
        </div>
        <button
          onClick={onClose}
          style={{ width: "100%", padding: "9px 0", borderRadius: 7, border: "1px solid #cbd5e1", background: "#fff", color: "#475569", fontSize: 14, fontWeight: 500, cursor: "pointer" }}
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
