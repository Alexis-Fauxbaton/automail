import { Form } from "react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MailConnection } from "@prisma/client";

export default function DisconnectModal(props: {
  connection: MailConnection;
  threadCount: number;
  onClose: () => void;
}) {
  const { connection, threadCount, onClose } = props;
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState("");
  const canSubmit = confirmText === connection.email;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: "28px 28px 24px",
          maxWidth: 440,
          width: "90%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 12px", fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
          {t("connections.disconnectTitle")}
        </h2>
        <p style={{ margin: "0 0 8px", fontSize: 14, color: "#b91c1c", background: "#fef2f2", padding: "10px 14px", borderRadius: 8 }}>
          {t("connections.disconnectWarning", { threadCount })}
        </p>
        <p style={{ margin: "16px 0 6px", fontSize: 14, color: "#475569" }}>
          {t("connections.typeEmailToConfirm", { email: connection.email })}
        </p>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={connection.email}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 12px",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            fontSize: 14,
            marginBottom: 20,
            outline: "none",
          }}
        />
        <Form method="post">
          <input type="hidden" name="intent" value="disconnect" />
          <input type="hidden" name="mailConnectionId" value={connection.id} />
          <input type="hidden" name="confirmEmail" value={confirmText} />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "8px 18px",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                background: "#fff",
                color: "#475569",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                padding: "8px 18px",
                borderRadius: 6,
                border: "none",
                background: canSubmit ? "#dc2626" : "#fca5a5",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: canSubmit ? "pointer" : "not-allowed",
              }}
            >
              {t("connections.disconnectConfirm")}
            </button>
          </div>
        </Form>
      </div>
    </div>
  );
}
