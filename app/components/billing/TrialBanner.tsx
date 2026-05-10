import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { Link } from "react-router";

const DISMISS_KEY = (shop: string) => `automail_trial_active_dismissed_${shop}`;

/**
 * Banner shown during trial states.
 * - trial_active: blue info banner with countdown + CTA, dismissible 1× (persists in localStorage)
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
      <div role="status" style={activeStyle}>
        <span style={iconBoxBlue} aria-hidden>ⓘ</span>
        <span style={textStyle}>{t('billing.trial.activeBanner', { count: ent.trialDaysRemaining ?? 0 })}</span>
        <Link to="/app/billing" style={ctaPrimaryBlue}>
          {t('billing.choosePlan')}
        </Link>
        <button onClick={handleDismiss} style={dismissBtn} aria-label={t('common.dismiss')}>
          <span aria-hidden>×</span>
        </button>
      </div>
    );
  }

  if (ent.state === 'trial_expired') {
    return (
      <div role="alert" style={expiredStyle}>
        <span style={iconBoxRed} aria-hidden>!</span>
        <span style={textStyle}>{t('billing.trial.expiredBanner')}</span>
        <Link to="/app/billing" style={ctaPrimaryRed}>
          {t('billing.choosePlan')}
        </Link>
      </div>
    );
  }

  return null;
}

const baseStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
  borderRadius: 10,
  fontSize: 13.5,
  lineHeight: 1.4,
  flex: 1,
  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)',
};

const activeStyle: React.CSSProperties = {
  ...baseStyle,
  background: '#eff6ff',
  color: '#1e3a8a',
  border: '1px solid #bfdbfe',
};

const expiredStyle: React.CSSProperties = {
  ...baseStyle,
  background: '#fef2f2',
  color: '#991b1b',
  border: '1px solid #fecaca',
};

const iconBox: React.CSSProperties = {
  flexShrink: 0,
  width: 22,
  height: 22,
  borderRadius: '50%',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 14,
  fontWeight: 700,
};

const iconBoxBlue: React.CSSProperties = {
  ...iconBox,
  background: '#bfdbfe',
  color: '#1e3a8a',
};

const iconBoxRed: React.CSSProperties = {
  ...iconBox,
  background: '#fecaca',
  color: '#991b1b',
};

const textStyle: React.CSSProperties = {
  flex: 1,
  fontWeight: 500,
};

const ctaBase: React.CSSProperties = {
  flexShrink: 0,
  fontWeight: 600,
  textDecoration: 'none',
  fontSize: 13,
  padding: '6px 12px',
  borderRadius: 6,
  whiteSpace: 'nowrap',
};

const ctaPrimaryBlue: React.CSSProperties = {
  ...ctaBase,
  background: '#1e40af',
  color: 'white',
};

const ctaPrimaryRed: React.CSSProperties = {
  ...ctaBase,
  background: '#991b1b',
  color: 'white',
};

const dismissBtn: React.CSSProperties = {
  flexShrink: 0,
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 18,
  lineHeight: 1,
  width: 24,
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 4,
  opacity: 0.6,
};
