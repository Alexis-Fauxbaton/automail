import { useEntitlements } from "../../lib/billing/entitlements-context";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

/**
 * Inbox-level banner shown when auto-sync is paused due to billing state.
 * Distinct from QuotaBanner (which lives at app root): this one explains
 * specifically that incoming mails are NOT being fetched, so the inbox
 * may appear stale.
 */
export function SyncSuspendedBanner() {
  const ent = useEntitlements();
  const { t } = useTranslation();

  if (!ent.isSyncSuspended) return null;

  return (
    <div role="alert" style={{
      background: '#ffedd5',
      color: '#9a3412',
      border: '1px solid #fdba74',
      padding: '12px 16px',
      borderRadius: 8,
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      fontSize: 14,
      lineHeight: 1.45,
      marginBottom: 12,
    }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        {t('billing.syncSuspended.banner')}
      </span>
      <Link
        to="/app/billing"
        style={{
          flexShrink: 0,
          fontWeight: 600,
          textDecoration: 'none',
          fontSize: 13,
          padding: '6px 12px',
          borderRadius: 6,
          background: '#9a3412',
          color: 'white',
          whiteSpace: 'nowrap',
        }}
      >
        {t('billing.upgradeCta')}
      </Link>
    </div>
  );
}
