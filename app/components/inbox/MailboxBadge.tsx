import { mailboxColor } from "../../lib/mail/mailbox-color";

export default function MailboxBadge(props: {
  email: string;
  provider: string;
  paused?: boolean;
  compact?: boolean;
}) {
  const { email, provider, paused, compact } = props;
  const c = mailboxColor(email);
  const providerLetter =
    provider === "gmail" ? "G" : provider === "outlook" ? "O" : "Z";
  const providerColor =
    provider === "gmail"
      ? "#ea4335"
      : provider === "outlook"
        ? "#0078d4"
        : "#dc2626";
  const localPart = email.split("@")[0];
  return (
    <>
      {/* Scoped media query — injected once via the component file. Avoids a
          separate CSS file while keeping inline-style-only approach. */}
      <style>{`
        .mailbox-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          white-space: nowrap;
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mailbox-badge .provider-mark {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          border-radius: 2px;
          color: #fff;
          font-size: 9px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .mailbox-badge .email-label {
          overflow: hidden;
          text-overflow: ellipsis;
        }
        @media (max-width: 640px) {
          .mailbox-badge .provider-mark {
            display: none;
          }
          .mailbox-badge {
            font-size: 10px;
            padding: 2px 6px;
          }
        }
      `}</style>
      <span
        className="mailbox-badge"
        style={{ background: c.bg, color: c.fg }}
        title={email}
      >
        {!compact && (
          <span
            className="provider-mark"
            style={{ background: providerColor }}
          >
            {providerLetter}
          </span>
        )}
        {paused && <span className="paused-icon">⏸</span>}
        <span className="email-label">
          {compact ? `${localPart}@` : email}
        </span>
      </span>
    </>
  );
}
