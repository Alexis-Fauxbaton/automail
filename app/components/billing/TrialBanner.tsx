import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { Link } from "react-router";

const DISMISS_KEY = (shop: string) => `automail_trial_active_dismissed_${shop}`;

/**
 * Banner shown during trial states.
 * - trial_active: blue info banner with countdown + CTA to choose plan, dismissible (1×, persists in localStorage)
 * - trial_expired: red blocking banner with CTA, NOT dismissible
 */
export function TrialBanner() {
  const ent = useEntitlements();
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  const storageKey = DISMISS_KEY(ent.shop);

  useEffect(() => {
    setDismissed(localStorage.getItem(storageKey) === '1');
  }, [storageKey]);

  if (ent.state === 'trial_active' && !dismissed) {
    const handleDismiss = () => {
      localStorage.setItem(storageKey, '1');
      setDismissed(true);
    };
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
        <span style={{ display: 'flex', gap: 12 }}>
          <Link to="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
            {t('billing.choosePlan')}
          </Link>
          <button onClick={handleDismiss} style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
          }} aria-label="Dismiss">×</button>
        </span>
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
        <Link to="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
          {t('billing.choosePlan')}
        </Link>
      </div>
    );
  }

  return null;
}
