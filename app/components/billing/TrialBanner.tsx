import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";

/**
 * Banner shown during trial states.
 * - trial_active: blue info banner with countdown + CTA to choose plan
 * - trial_expired: red blocking banner with CTA
 */
export function TrialBanner() {
  const ent = useEntitlements();
  const { t } = useTranslation();

  if (ent.state === 'trial_active') {
    return (
      <div role="status" style={{
        background: '#dbeafe',
        color: '#1e3a8a',
        border: '1px solid #93c5fd',
        padding: '8px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 14,
      }}>
        <span>{t('billing.trial.activeBanner', { count: ent.trialDaysRemaining ?? 0 })}</span>
        <a href="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
          {t('billing.choosePlan')}
        </a>
      </div>
    );
  }

  if (ent.state === 'trial_expired') {
    return (
      <div role="alert" style={{
        background: '#fee2e2',
        color: '#991b1b',
        border: '1px solid #fca5a5',
        padding: '8px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 14,
      }}>
        <span>{t('billing.trial.expiredBanner')}</span>
        <a href="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
          {t('billing.choosePlan')}
        </a>
      </div>
    );
  }

  return null;
}
