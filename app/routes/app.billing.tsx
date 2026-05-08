import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useEffect } from "react";

import { authenticate } from "../shopify.server";
import { resolveEntitlements } from "../lib/billing/entitlements";
import { getPendingChange } from "../lib/billing/scheduled-changes";
import { PLANS } from "../lib/billing/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const ent = await resolveEntitlements({ shop: session.shop, admin });
  const pendingChange = await getPendingChange(session.shop);
  return {
    entitlements: {
      state: ent.state,
      planId: ent.planId,
      trialDaysRemaining: ent.trialDaysRemaining,
      trialExpiresAt: ent.trialExpiresAt?.toISOString() ?? null,
      quotaStatus: { ...ent.quotaStatus, periodStart: ent.quotaStatus.periodStart.toISOString() },
      mailboxStatus: ent.mailboxStatus,
    },
    pendingChange: pendingChange
      ? {
          fromPlan: pendingChange.fromPlan,
          toPlan: pendingChange.toPlan,
          effectiveAt: pendingChange.effectiveAt.toISOString(),
        }
      : null,
  };
};

export default function BillingPage() {
  const { entitlements, pendingChange } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const subscribeFetcher = useFetcher<{ confirmationUrl?: string; error?: string }>();
  const cancelFetcher = useFetcher<{ cancelled?: boolean; scheduled?: boolean; cancelledScheduled?: boolean; error?: string }>();
  const [searchParams] = useSearchParams();
  const justSubscribed = searchParams.get('subscribed') === '1';

  useEffect(() => {
    const url = subscribeFetcher.data?.confirmationUrl;
    if (url && typeof window !== 'undefined' && window.top) {
      window.top.location.href = url;
    }
  }, [subscribeFetcher.data]);

  useEffect(() => {
    if (cancelFetcher.data && 'cancelledScheduled' in cancelFetcher.data && cancelFetcher.data.cancelledScheduled) {
      if (typeof window !== 'undefined') window.location.reload();
    }
  }, [cancelFetcher.data]);

  const subscribe = (planId: 'starter' | 'pro') => {
    const fd = new FormData();
    fd.set('planId', planId);
    subscribeFetcher.submit(fd, { method: 'POST', action: '/api/billing/subscribe' });
  };

  const cancel = (mode: 'immediate' | 'downgrade', toPlan?: string) => {
    const fd = new FormData();
    fd.set('mode', mode);
    if (toPlan) fd.set('toPlan', toPlan);
    cancelFetcher.submit(fd, { method: 'POST', action: '/api/billing/cancel' });
  };

  const loading = subscribeFetcher.state !== 'idle' || cancelFetcher.state !== 'idle';

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>{t('billing.page.title')}</h1>

      {justSubscribed && (
        <div style={{ background: '#dcfce7', color: '#14532d', padding: '10px 14px', borderRadius: 6, marginBottom: 20 }}>
          {t('billing.page.subscribedSuccess')}
        </div>
      )}

      {pendingChange && (
        <div style={{ background: '#fef9c3', color: '#854d0e', padding: '10px 14px', borderRadius: 6, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span>
            {t('billing.page.scheduledChangeNotice', {
              fromPlan: pendingChange.fromPlan,
              toPlan: pendingChange.toPlan,
              date: new Date(pendingChange.effectiveAt).toLocaleDateString(),
            })}
          </span>
          <button
            onClick={() => {
              const fd = new FormData();
              fd.set('mode', 'cancel_scheduled');
              cancelFetcher.submit(fd, { method: 'POST', action: '/api/billing/cancel' });
            }}
            disabled={loading}
            style={{ fontWeight: 600, background: 'transparent', border: '1px solid #854d0e', borderRadius: 4, padding: '4px 10px', color: 'inherit', cursor: 'pointer' }}
          >
            {t('billing.page.cancelScheduled')}
          </button>
        </div>
      )}

      <p>{t('billing.page.currentState', { state: entitlements.state, plan: entitlements.planId ?? '—' })}</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 32 }}>
        <PlanCard
          planId="starter"
          isCurrent={entitlements.planId === 'starter'}
          onSubscribe={() => subscribe('starter')}
          onDowngrade={() => cancel('downgrade', 'starter')}
          loading={loading}
          showDowngrade={entitlements.planId === 'pro'}
        />
        <PlanCard
          planId="pro"
          isCurrent={entitlements.planId === 'pro'}
          onSubscribe={() => subscribe('pro')}
          onDowngrade={() => {}}
          loading={loading}
          showDowngrade={false}
        />
      </div>

      {entitlements.state === 'paid_active' && (
        <div style={{ marginTop: 32 }}>
          <button onClick={() => cancel('immediate')} disabled={loading} style={{ color: '#991b1b', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
            {t('billing.page.cancelSubscription')}
          </button>
        </div>
      )}
    </div>
  );
}

function PlanCard(props: {
  planId: 'starter' | 'pro';
  isCurrent: boolean;
  onSubscribe: () => void;
  onDowngrade: () => void;
  loading: boolean;
  showDowngrade: boolean;
}) {
  const { t } = useTranslation();
  const plan = PLANS[props.planId];

  return (
    <div style={{
      border: props.isCurrent ? '2px solid #1f2937' : '1px solid #d1d5db',
      borderRadius: 8,
      padding: '20px 24px',
    }}>
      <h2 style={{ marginTop: 0, textTransform: 'capitalize' }}>{props.planId}</h2>
      <p style={{ fontSize: 28, fontWeight: 700 }}>${plan.priceUsd}<span style={{ fontSize: 14, fontWeight: 400 }}>/mo</span></p>
      <ul style={{ paddingLeft: 18 }}>
        <li>{t('billing.plan.draftsPerMonth', { count: plan.draftsPerMonth })}</li>
        <li>{t('billing.plan.maxMailboxes', { count: plan.maxMailboxes })}</li>
        <li>{plan.advancedDashboard ? t('billing.plan.advancedDashboard') : t('billing.plan.basicDashboard')}</li>
        <li>{t('billing.plan.dashboardRange', { count: plan.dashboardMaxRangeDays })}</li>
      </ul>
      {props.isCurrent ? (
        <p style={{ color: '#16a34a', fontWeight: 600 }}>{t('billing.plan.currentPlan')}</p>
      ) : props.showDowngrade ? (
        <button onClick={props.onDowngrade} disabled={props.loading} style={{ width: '100%', padding: '8px 16px', borderRadius: 6 }}>
          {t('billing.plan.downgradeBtn')}
        </button>
      ) : (
        <button onClick={props.onSubscribe} disabled={props.loading} style={{ width: '100%', background: '#1f2937', color: 'white', padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer' }}>
          {props.loading ? t('billing.plan.processing') : t('billing.plan.subscribeBtn')}
        </button>
      )}
    </div>
  );
}
