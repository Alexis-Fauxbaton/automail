import { useTranslation } from "react-i18next";
import { Link } from "react-router";

/**
 * Controlled modal shown by call sites when a generation attempt is blocked.
 * Caller passes `open` and `onClose` and optionally a custom message variant.
 */
export function QuotaExceededModal(props: {
  open: boolean;
  onClose: () => void;
  variant?: 'exceeded' | 'just_used_last';
  used?: number;
  limit?: number;
}) {
  const { t } = useTranslation();
  if (!props.open) return null;

  const variant = props.variant ?? 'exceeded';
  const titleKey = variant === 'just_used_last' ? 'billing.modal.lastUsedTitle' : 'billing.modal.exceededTitle';
  const bodyKey = variant === 'just_used_last' ? 'billing.modal.lastUsedBody' : 'billing.modal.exceededBody';

  return (
    <div style={overlay} onClick={props.onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>
          {t(titleKey, { used: props.used ?? 0, limit: props.limit ?? 0 })}
        </h2>
        <p style={{ margin: '0 0 20px', fontSize: 14, color: '#374151' }}>
          {t(bodyKey, { used: props.used ?? 0, limit: props.limit ?? 0 })}
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button onClick={props.onClose} style={btnSecondary}>
            {t('billing.modal.later')}
          </button>
          <Link to="/app/billing" style={btnPrimary}>
            {t('billing.modal.viewPlans')}
          </Link>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
};

const modal: React.CSSProperties = {
  background: 'white',
  borderRadius: 8,
  padding: '24px 28px',
  maxWidth: 460,
  width: '90%',
  boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
  fontFamily: 'system-ui, sans-serif',
};

const btnPrimary: React.CSSProperties = {
  background: '#1f2937',
  color: 'white',
  padding: '8px 16px',
  borderRadius: 6,
  textDecoration: 'none',
  fontSize: 14,
  fontWeight: 600,
};

const btnSecondary: React.CSSProperties = {
  background: 'transparent',
  color: '#374151',
  padding: '8px 16px',
  borderRadius: 6,
  fontSize: 14,
  border: '1px solid #d1d5db',
  cursor: 'pointer',
};
