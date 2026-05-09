import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";

/**
 * Permanent counter visible on every page of the app.
 * Shows: "47 / 50 drafts" with color pastille, or "Trial — 9 days left", or "0 / 50 — quota reached".
 *
 * Internal shops (state=internal) hide the widget entirely (would always read 0/∞).
 */
export function TopBarCounter() {
  const ent = useEntitlements();
  const { t } = useTranslation();

  if (ent.state === 'internal') return null;

  if (ent.state === 'trial_active') {
    return (
      <div style={styles.wrapper}>
        <span style={styles.dotInfo} />
        <span style={styles.label}>
          {t('billing.trialDaysLeft', { count: ent.trialDaysRemaining ?? 0 })}
        </span>
      </div>
    );
  }

  if (ent.state === 'trial_expired') {
    return (
      <div style={styles.wrapper}>
        <span style={styles.dotExceeded} />
        <span style={styles.label}>{t('billing.trialExpired')}</span>
      </div>
    );
  }

  // paid_active
  const { used, limit, level } = ent.quotaStatus;
  const dot = level === 'exceeded' ? styles.dotExceeded
            : level === 'critical' ? styles.dotCritical
            : level === 'warning'  ? styles.dotWarning
            : styles.dotOk;

  return (
    <div style={styles.wrapper}>
      <span style={dot} />
      <span style={styles.label}>
        {t('billing.draftsCount', { used, limit: Number.isFinite(limit) ? limit : '∞' })}
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    flexShrink: 0,
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'system-ui, sans-serif',
    color: '#1f2937',
    background: 'white',
    border: '1px solid #e2e8f0',
    borderRadius: 999,
    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
  },
  label: { fontVariantNumeric: 'tabular-nums' },
  dotOk:        { width: 8, height: 8, borderRadius: '50%', background: '#16a34a' },
  dotWarning:   { width: 8, height: 8, borderRadius: '50%', background: '#eab308' },
  dotCritical:  { width: 8, height: 8, borderRadius: '50%', background: '#f97316' },
  dotExceeded:  { width: 8, height: 8, borderRadius: '50%', background: '#dc2626' },
  dotInfo:      { width: 8, height: 8, borderRadius: '50%', background: '#2563eb' },
};
