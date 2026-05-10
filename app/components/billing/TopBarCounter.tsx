import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";

const DISMISS_KEY = (shop: string) => `automail_floating_counter_dismissed_${shop}`;

/**
 * Permanent counter visible on every page of the app.
 * Shows: "47 / 50 drafts" with color pastille, or "Trial — 9 days left", or "0 / 50 — quota reached".
 *
 * Internal shops (state=internal) hide the widget entirely (would always read 0/∞).
 *
 * `variant="floating"` renders the same counter as a fixed pill in the
 * bottom-right corner so quota usage stays visible while the user scrolls
 * past the (non-sticky) top app-shell bar. Floating variant is dismissible
 * (persisted in localStorage); the dismissed state shrinks to a compact
 * icon+value pill that stays self-explanatory and clickable to restore.
 */
export function TopBarCounter({ variant = 'inline' }: { variant?: 'inline' | 'floating' } = {}) {
  const ent = useEntitlements();
  const { t } = useTranslation();
  const storageKey = DISMISS_KEY(ent.shop);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (variant !== 'floating') return;
    setDismissed(localStorage.getItem(storageKey) === '1');
  }, [variant, storageKey]);

  if (ent.state === 'internal') return null;

  // During trial_active the inline TopBarCounter would duplicate the
  // TrialBanner that sits next to it — keep it hidden inline. The floating
  // variant has no banner around it, so it's fine to show the trial state
  // there.
  if (ent.state === 'trial_active' && variant === 'inline') return null;

  // ─── Dismissed floating ────────────────────────────────────────────────
  // Compact dark pill with [icon] + value. Same visual language as the full
  // pill, so the user immediately recognises it; the icon disambiguates
  // "what does this number mean" (clock = trial, envelope = drafts).
  if (variant === 'floating' && dismissed) {
    let icon = ICON_DRAFT;
    let value = '—';
    let bg = '#0f172a';
    if (ent.state === 'trial_active') {
      icon = ICON_CLOCK;
      value = `${ent.trialDaysRemaining ?? 0}j`;
    } else if (ent.state === 'trial_expired') {
      icon = ICON_WARNING;
      value = '!';
      bg = '#7f1d1d';
    } else if (ent.state === 'paid_active') {
      icon = ICON_DRAFT;
      const lvl = ent.quotaStatus.level;
      bg = lvl === 'exceeded' ? '#7f1d1d'
         : lvl === 'critical' ? '#7c2d12'
         : lvl === 'warning' ? '#713f12'
         : '#0f172a';
      const used = ent.quotaStatus.used;
      const limit = ent.quotaStatus.limit;
      value = Number.isFinite(limit) ? `${used}/${limit}` : `${used}`;
    }
    return (
      <button
        type="button"
        aria-label={t('billing.showCounter', { defaultValue: 'Afficher le compteur' })}
        title={t('billing.showCounter', { defaultValue: 'Afficher le compteur' })}
        onClick={() => {
          localStorage.removeItem(storageKey);
          setDismissed(false);
        }}
        style={{ ...styles.dismissedPill, background: bg }}
      >
        <span style={styles.dismissedIcon} aria-hidden>{icon}</span>
        <span style={styles.label}>{value}</span>
      </button>
    );
  }

  const wrapperStyle = variant === 'floating' ? styles.wrapperFloating : styles.wrapper;

  const dismissBtn = variant === 'floating' ? (
    <button
      type="button"
      aria-label={t('common.dismiss', { defaultValue: 'Fermer' })}
      title={t('common.dismiss', { defaultValue: 'Réduire' })}
      onClick={() => {
        localStorage.setItem(storageKey, '1');
        setDismissed(true);
      }}
      style={styles.dismissBtn}
    >
      ×
    </button>
  ) : null;

  if (ent.state === 'trial_active') {
    const days = ent.trialDaysRemaining ?? 0;
    return (
      <div style={wrapperStyle}>
        <span style={styles.dotInfo} />
        <span style={styles.label}>{t('billing.trial.activeShort', { count: days, defaultValue: `${days}j d'essai` })}</span>
        {dismissBtn}
      </div>
    );
  }

  if (ent.state === 'trial_expired') {
    return (
      <div style={wrapperStyle}>
        <span style={styles.dotExceeded} />
        <span style={styles.label}>{t('billing.trialExpired')}</span>
        {dismissBtn}
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
    <div style={wrapperStyle}>
      <span style={dot} />
      <span style={styles.label}>
        {t('billing.draftsCount', { used, limit: Number.isFinite(limit) ? limit : '∞' })}
      </span>
      {dismissBtn}
    </div>
  );
}

// ─── Inline icons ────────────────────────────────────────────────────────
// Tiny SVG glyphs sized for the dismissed pill.

const ICON_CLOCK = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

const ICON_DRAFT = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6h16v12H4z" />
    <path d="M4 6l8 7 8-7" />
  </svg>
);

const ICON_WARNING = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l10 18H2L12 3z" />
    <path d="M12 10v5" />
    <path d="M12 18.5v.01" />
  </svg>
);

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
  wrapperFloating: {
    position: 'fixed',
    bottom: 20,
    right: 20,
    zIndex: 1000,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px 10px 18px',
    fontSize: 15,
    fontWeight: 600,
    fontFamily: 'system-ui, sans-serif',
    color: '#f8fafc',
    background: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: 999,
    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.28)',
  },
  label: { fontVariantNumeric: 'tabular-nums' },
  dotOk:        { width: 8, height: 8, borderRadius: '50%', background: '#16a34a' },
  dotWarning:   { width: 8, height: 8, borderRadius: '50%', background: '#eab308' },
  dotCritical:  { width: 8, height: 8, borderRadius: '50%', background: '#f97316' },
  dotExceeded:  { width: 8, height: 8, borderRadius: '50%', background: '#dc2626' },
  dotInfo:      { width: 8, height: 8, borderRadius: '50%', background: '#2563eb' },
  dismissBtn: {
    flexShrink: 0,
    background: 'transparent',
    border: 'none',
    color: '#cbd5e1',
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: 1,
    width: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    padding: 0,
    opacity: 0.8,
  },
  dismissedPill: {
    position: 'fixed',
    bottom: 20,
    right: 20,
    zIndex: 1000,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '7px 12px 7px 11px',
    background: '#0f172a',
    border: 'none',
    color: '#f8fafc',
    fontWeight: 600,
    fontSize: 13,
    lineHeight: 1,
    fontFamily: 'system-ui, sans-serif',
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    borderRadius: 999,
    boxShadow: '0 6px 18px rgba(15, 23, 42, 0.28)',
  },
  dismissedIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#f8fafc',
    opacity: 0.95,
  },
};
