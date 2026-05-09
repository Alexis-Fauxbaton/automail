import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";
import { Link } from "react-router";

const DISMISS_KEY = (shop: string, periodStart: string, level: string) =>
  `automail_quota_dismiss_${shop}_${periodStart}_${level}`;

/**
 * Top-of-page banner reflecting the quota level.
 * - warning (80%): yellow, dismissible per period
 * - critical (95%): orange, dismissible per period
 * - exceeded (100%): red, NOT dismissible
 *
 * Hidden during trial (use TrialBanner instead).
 */
export function QuotaBanner() {
  const ent = useEntitlements();
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  const periodKey = ent.quotaStatus.periodStart.toISOString();
  const level = ent.quotaStatus.level;
  const storageKey = DISMISS_KEY(ent.shop, periodKey, level);

  useEffect(() => {
    if (level === 'exceeded') {
      setDismissed(false);
      return;
    }
    setDismissed(localStorage.getItem(storageKey) === '1');
  }, [storageKey, level]);

  if (ent.state !== 'paid_active') return null;
  if (level === 'ok') return null;
  if (dismissed && level !== 'exceeded') return null;

  const handleDismiss = () => {
    localStorage.setItem(storageKey, '1');
    setDismissed(true);
  };

  const palette = ({
    warning: { bg: '#fefce8', fg: '#854d0e', border: '#fde68a', iconBg: '#fde68a', iconFg: '#854d0e', cta: '#a16207', icon: 'ⓘ' },
    critical: { bg: '#fff7ed', fg: '#9a3412', border: '#fdba74', iconBg: '#fdba74', iconFg: '#9a3412', cta: '#c2410c', icon: '!' },
    exceeded: { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', iconBg: '#fecaca', iconFg: '#991b1b', cta: '#991b1b', icon: '!' },
    ok: { bg: '', fg: '', border: '', iconBg: '', iconFg: '', cta: '', icon: '' },
  } as const)[level];

  return (
    <div role="alert" style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 14px',
      borderRadius: 10,
      fontSize: 13.5,
      lineHeight: 1.4,
      flex: 1,
      boxShadow: '0 1px 3px rgba(15, 23, 42, 0.04)',
      background: palette.bg,
      color: palette.fg,
      border: `1px solid ${palette.border}`,
    }}>
      <span aria-hidden style={{
        flexShrink: 0,
        width: 22, height: 22,
        borderRadius: '50%',
        background: palette.iconBg,
        color: palette.iconFg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        fontWeight: 700,
      }}>{palette.icon}</span>
      <span style={{ flex: 1, fontWeight: 500 }}>
        {t(`billing.banner.${level}`, { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit })}
      </span>
      <Link to="/app/billing" style={{
        flexShrink: 0,
        fontWeight: 600,
        textDecoration: 'none',
        fontSize: 13,
        padding: '6px 12px',
        borderRadius: 6,
        whiteSpace: 'nowrap',
        background: palette.cta,
        color: 'white',
      }}>
        {t('billing.upgradeCta')}
      </Link>
      {level !== 'exceeded' && (
        <button onClick={handleDismiss} aria-label="Dismiss" style={{
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
        }}>×</button>
      )}
    </div>
  );
}
