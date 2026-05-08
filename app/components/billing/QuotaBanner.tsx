import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";
import { useState, useEffect } from "react";

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
    warning: { bg: '#fef9c3', fg: '#854d0e', border: '#fde047' },
    critical: { bg: '#ffedd5', fg: '#9a3412', border: '#fdba74' },
    exceeded: { bg: '#fee2e2', fg: '#991b1b', border: '#fca5a5' },
    ok: { bg: '', fg: '', border: '' },
  } as const)[level];

  return (
    <div role="alert" style={{
      background: palette.bg,
      color: palette.fg,
      border: `1px solid ${palette.border}`,
      padding: '8px 14px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontSize: 14,
    }}>
      <span>{t(`billing.banner.${level}`, { used: ent.quotaStatus.used, limit: ent.quotaStatus.limit })}</span>
      <span style={{ display: 'flex', gap: 12 }}>
        <a href="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
          {t('billing.upgradeCta')}
        </a>
        {level !== 'exceeded' && (
          <button onClick={handleDismiss} style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
          }}>×</button>
        )}
      </span>
    </div>
  );
}
