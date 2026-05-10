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
      padding: '10px 14px',
      borderRadius: 6,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontSize: 14,
      marginBottom: 12,
    }}>
      <span>{t('billing.syncSuspended.banner')}</span>
      <Link to="/app/billing" style={{ color: 'inherit', fontWeight: 600 }}>
        {t('billing.upgradeCta')}
      </Link>
    </div>
  );
}
