import { useState, useEffect } from "react";
import { useFetcher, Link } from "react-router";
import { useTranslation } from "react-i18next";

type SendState = "idle" | "pending" | "sent" | "error" | "needs-reauth";

const COUNTDOWN_MS = 10_000;

export default function SendButton(props: {
  shop: string;
  mailConnectionId: string;
  draftId: string;
  customerEmail: string;
  canSend: boolean;
  reauthUrl?: string;
  initialSentAt?: string | null;
  disabled?: boolean;
}) {
  const { canSend, draftId, mailConnectionId, customerEmail, reauthUrl, initialSentAt, disabled } = props;
  const { t } = useTranslation();
  const fetcher = useFetcher();

  const [state, setState] = useState<SendState>(
    initialSentAt ? "sent" : (canSend ? "idle" : "needs-reauth")
  );
  const [countdown, setCountdown] = useState(10);
  const [errorMsg, setErrorMsg] = useState("");

  // Countdown ticker
  useEffect(() => {
    if (state !== "pending") return;
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, COUNTDOWN_MS - elapsed);
      setCountdown(Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        clearInterval(interval);
        actuallySend();
      }
    }, 100);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // React to fetcher response
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const data = fetcher.data as any;
    if (data.sent) {
      setState("sent");
    } else if (data.needsReauth) {
      setState("needs-reauth");
    } else if (data.error) {
      setState("error");
      setErrorMsg(data.error);
    }
  }, [fetcher.state, fetcher.data]);

  const startCountdown = () => {
    setState("pending");
    setCountdown(10);
  };
  const cancelCountdown = () => {
    setState("idle");
  };
  const actuallySend = () => {
    const fd = new FormData();
    fd.append("intent", "send");
    fd.append("mailConnectionId", mailConnectionId);
    fd.append("draftId", draftId);
    fetcher.submit(fd, { method: "post" });
  };

  if (disabled) {
    return (
      <button
        disabled
        style={btnStyle({ disabled: true })}
        title={t("inbox.send.disabled_no_draft")}
      >
        {t("inbox.send.cta")}
      </button>
    );
  }

  if (state === "needs-reauth") {
    // Use react-router Link (not native <a>) so navigation stays in the
    // embedded Shopify iframe and preserves shop/host/embedded query params.
    // A native <a> triggers a full reload that drops those params, leading
    // to a redirect to Shopify auth.
    return (
      <Link
        to={reauthUrl ?? `/app/mail-auth/reauth?mailConnectionId=${mailConnectionId}`}
        style={btnStyle({ variant: "reauth" })}
      >
        🔒 {t("inbox.send.activate")}
      </Link>
    );
  }

  if (state === "sent") {
    return (
      <span style={{ color: "#22863a", fontWeight: 500 }}>
        ✓ {t("inbox.send.sent")}
      </span>
    );
  }

  if (state === "pending") {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "8px 12px", background: "#eef6ff",
        border: "1px solid #b8d4f5", borderRadius: 6,
      }}>
        <span>✓ {t("inbox.send.pending", { customer: customerEmail, seconds: countdown })}</span>
        <button
          onClick={cancelCountdown}
          style={{
            background: "transparent", border: "1px solid #1a73e8",
            color: "#1a73e8", padding: "4px 10px", borderRadius: 4, cursor: "pointer",
          }}
        >
          {t("inbox.send.cancel")}
        </button>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "#cb2431" }}>⚠ {errorMsg}</span>
        <button onClick={startCountdown} style={btnStyle({})}>
          {t("inbox.send.retry")}
        </button>
      </div>
    );
  }

  // idle
  return (
    <button onClick={startCountdown} style={btnStyle({ variant: "primary" })}>
      {t("inbox.send.cta")}
    </button>
  );
}

function btnStyle(opts: { variant?: "primary" | "reauth"; disabled?: boolean }) {
  return {
    background: opts.disabled
      ? "#e0e0e0"
      : (opts.variant === "reauth" ? "#f5f5f5" : "#1a1a1a"),
    color: opts.disabled
      ? "#999"
      : (opts.variant === "reauth" ? "#1a1a1a" : "white"),
    border: opts.variant === "reauth" ? "1px solid #ccc" : "none",
    padding: "10px 20px",
    borderRadius: 6,
    fontWeight: 500,
    cursor: opts.disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    textDecoration: "none",
    display: "inline-block",
  } as const;
}
