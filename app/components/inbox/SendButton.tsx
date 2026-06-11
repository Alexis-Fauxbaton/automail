import { useState, useEffect } from "react";
import { useFetcher, Link } from "react-router";
import { useTranslation } from "react-i18next";

type SendState = "idle" | "pending" | "sending" | "sent" | "error" | "needs-reauth";

// Safety countdown for the delayed-send mode. Immediate mode bypasses it.
const COUNTDOWN_MS = 5_000;
const COUNTDOWN_SECONDS = COUNTDOWN_MS / 1000;

function PlaneIcon({ color = "#fff" }: { color?: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export default function SendButton(props: {
  mailConnectionId: string;
  draftId: string;
  customerEmail: string;
  canSend: boolean;
  immediateSend: boolean;
  reauthUrl?: string;
  initialSentAt?: string | null;
  disabled?: boolean;
}) {
  const {
    canSend,
    draftId,
    mailConnectionId,
    customerEmail,
    reauthUrl,
    initialSentAt,
    disabled,
    immediateSend,
  } = props;
  const { t } = useTranslation();
  const fetcher = useFetcher();

  const [state, setState] = useState<SendState>(
    initialSentAt ? "sent" : canSend ? "idle" : "needs-reauth",
  );
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [errorMsg, setErrorMsg] = useState("");

  const actuallySend = () => {
    const fd = new FormData();
    fd.append("intent", "send");
    fd.append("mailConnectionId", mailConnectionId);
    fd.append("draftId", draftId);
    fetcher.submit(fd, { method: "post" });
  };

  // Countdown ticker — only runs in the delayed-send mode (state === "pending").
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

  // React to the send response.
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

  const beginSend = () => {
    if (immediateSend) {
      setState("sending");
      actuallySend();
    } else {
      setCountdown(COUNTDOWN_SECONDS);
      setState("pending");
    }
  };
  const cancelCountdown = () => {
    setState("idle");
  };

  if (disabled) {
    return (
      <button disabled className="am-send-btn" title={t("inbox.send.disabled_no_draft")}>
        <PlaneIcon color="#9ca3af" />
        {t("inbox.send.cta")}
      </button>
    );
  }

  if (state === "needs-reauth") {
    // react-router Link (not native <a>) so navigation stays in the embedded
    // Shopify iframe and preserves shop/host/embedded query params.
    return (
      <Link
        to={reauthUrl ?? `/app/mail-auth/reauth?mailConnectionId=${mailConnectionId}`}
        className="am-send-btn am-send-btn--reauth"
      >
        🔒 {t("inbox.send.activate")}
      </Link>
    );
  }

  if (state === "sent") {
    return (
      <span
        style={{
          color: "var(--ui-emerald-700)",
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        ✓ {t("inbox.send.sent")}
      </span>
    );
  }

  if (state === "sending") {
    return (
      <span style={{ color: "var(--ui-slate-500)", fontWeight: 500 }}>
        {t("inbox.send.sending")}
      </span>
    );
  }

  if (state === "pending") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "7px 12px",
          background: "#eef6ff",
          border: "1px solid #b8d4f5",
          borderRadius: 8,
        }}
      >
        <span>
          {t("inbox.send.pending", { customer: customerEmail, seconds: countdown })}
        </span>
        <button
          onClick={cancelCountdown}
          style={{
            background: "#fff",
            border: "1px solid #c9cccf",
            color: "#1a1a1a",
            padding: "5px 11px",
            borderRadius: 7,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 12.5,
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
        <button onClick={beginSend} className="am-send-btn">
          <PlaneIcon />
          {t("inbox.send.retry")}
        </button>
      </div>
    );
  }

  // idle
  return (
    <button onClick={beginSend} className="am-send-btn">
      <PlaneIcon />
      {t("inbox.send.cta")}
    </button>
  );
}
