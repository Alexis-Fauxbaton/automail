import { useTranslation } from "react-i18next";

export default function SoftPauseBanner(props: { pausedCount: number; limit: number }) {
  const { pausedCount, limit } = props;
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        background: "#fef9c3",
        border: "1px solid #fde68a",
        borderRadius: 8,
        padding: "14px 18px",
        marginBottom: 24,
        fontSize: 14,
        color: "#78350f",
      }}
    >
      <span aria-hidden style={{ fontSize: 18, lineHeight: 1.2, flexShrink: 0 }}>⚠</span>
      <p style={{ margin: 0 }}>
        {t("connections.softPauseBanner", { pausedCount, limit })}
      </p>
    </div>
  );
}
