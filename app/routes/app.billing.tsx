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
    <div style={{ padding: '2.5rem 1.5rem 4rem', fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: 960, margin: '0 auto', color: '#0f172a' }}>
      <header style={{ marginBottom: 32, textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: '#64748b' }}>
          {t('billing.page.eyebrow')}
        </p>
        <h1 style={{ margin: '8px 0 6px', fontSize: 32, fontWeight: 700, letterSpacing: -0.5 }}>
          {t('billing.page.title')}
        </h1>
        <p style={{ margin: 0, fontSize: 15, color: '#475569', maxWidth: 520, marginInline: 'auto' }}>
          {t('billing.page.lead')}
        </p>
      </header>

      {justSubscribed && (
        <div style={{ background: '#dcfce7', color: '#14532d', padding: '12px 16px', borderRadius: 8, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
          <span aria-hidden style={{ display: 'inline-flex', width: 20, height: 20, borderRadius: '50%', background: '#16a34a', color: 'white', fontSize: 13, fontWeight: 700, alignItems: 'center', justifyContent: 'center' }}>✓</span>
          {t('billing.page.subscribedSuccess')}
        </div>
      )}

      {pendingChange && (
        <div style={{ background: '#fef9c3', color: '#854d0e', padding: '12px 16px', borderRadius: 8, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, fontSize: 14 }}>
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
            style={{ fontWeight: 600, background: 'transparent', border: '1px solid #854d0e', borderRadius: 6, padding: '6px 12px', color: 'inherit', cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13 }}
          >
            {t('billing.page.cancelScheduled')}
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginTop: 8 }}>
        <PlanCard
          planId="starter"
          isCurrent={entitlements.planId === 'starter'}
          onSubscribe={() => subscribe('starter')}
          onDowngrade={() => cancel('downgrade', 'starter')}
          loading={loading}
          showDowngrade={entitlements.planId === 'pro'}
          recommended={false}
        />
        <PlanCard
          planId="pro"
          isCurrent={entitlements.planId === 'pro'}
          onSubscribe={() => subscribe('pro')}
          onDowngrade={() => {}}
          loading={loading}
          showDowngrade={false}
          recommended={entitlements.planId !== 'pro'}
        />
      </div>

      {entitlements.state === 'paid_active' && (
        <div style={{ marginTop: 36, textAlign: 'center' }}>
          <button
            onClick={() => cancel('immediate')}
            disabled={loading}
            style={{ color: '#64748b', background: 'transparent', border: 'none', cursor: loading ? 'not-allowed' : 'pointer', textDecoration: 'underline', fontSize: 13 }}
          >
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
  recommended: boolean;
}) {
  const { t } = useTranslation();
  const plan = PLANS[props.planId];

  const accent = props.isCurrent ? '#16a34a' : props.recommended ? '#1f2937' : '#e2e8f0';
  const features = [
    t('billing.plan.draftsPerMonth', { count: plan.draftsPerMonth }),
    t('billing.plan.maxMailboxes', { count: plan.maxMailboxes }),
    plan.advancedDashboard
      ? t('billing.plan.advancedDashboard', { count: plan.dashboardMaxRangeDays })
      : t('billing.plan.basicDashboard', { count: plan.dashboardMaxRangeDays }),
  ];

  return (
    <div style={{
      position: 'relative',
      border: `${props.isCurrent || props.recommended ? '2px' : '1px'} solid ${accent}`,
      borderRadius: 12,
      padding: '28px 24px 24px',
      background: 'white',
      boxShadow: props.recommended || props.isCurrent
        ? '0 4px 16px rgba(15, 23, 42, 0.06)'
        : '0 1px 3px rgba(15, 23, 42, 0.04)',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      {props.recommended && !props.isCurrent && (
        <span style={{
          position: 'absolute',
          top: -10,
          left: 20,
          background: '#1f2937',
          color: 'white',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          padding: '4px 10px',
          borderRadius: 4,
        }}>
          {t('billing.plan.recommended')}
        </span>
      )}
      {props.isCurrent && (
        <span style={{
          position: 'absolute',
          top: -10,
          left: 20,
          background: '#16a34a',
          color: 'white',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          padding: '4px 10px',
          borderRadius: 4,
        }}>
          {t('billing.plan.currentPlan')}
        </span>
      )}

      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, textTransform: 'capitalize', letterSpacing: -0.3 }}>
        {props.planId}
      </h2>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 40, fontWeight: 800, letterSpacing: -1 }}>${plan.priceUsd}</span>
        <span style={{ fontSize: 15, fontWeight: 500, color: '#64748b' }}>/{t('billing.plan.perMonth')}</span>
      </div>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {features.map((feature, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14, lineHeight: 1.45 }}>
            <span aria-hidden style={{
              flexShrink: 0,
              width: 18, height: 18,
              borderRadius: '50%',
              background: '#dcfce7',
              color: '#16a34a',
              fontSize: 11,
              fontWeight: 800,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 1,
            }}>✓</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <div style={{ marginTop: 'auto', paddingTop: 4 }}>
        {props.isCurrent ? (
          <button
            disabled
            style={{
              width: '100%',
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid #cbd5e1',
              background: '#f1f5f9',
              color: '#64748b',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'not-allowed',
            }}
          >
            {t('billing.plan.currentPlan')}
          </button>
        ) : props.showDowngrade ? (
          <button
            onClick={props.onDowngrade}
            disabled={props.loading}
            style={{
              width: '100%',
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid #cbd5e1',
              background: 'white',
              color: '#0f172a',
              fontWeight: 600,
              fontSize: 14,
              cursor: props.loading ? 'not-allowed' : 'pointer',
            }}
          >
            {props.loading ? t('billing.plan.processing') : t('billing.plan.downgradeBtn')}
          </button>
        ) : (
          <button
            onClick={props.onSubscribe}
            disabled={props.loading}
            style={{
              width: '100%',
              padding: '10px 16px',
              borderRadius: 8,
              border: 'none',
              background: '#1f2937',
              color: 'white',
              fontWeight: 600,
              fontSize: 14,
              cursor: props.loading ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => { if (!props.loading) e.currentTarget.style.background = '#0f172a'; }}
            onMouseLeave={(e) => { if (!props.loading) e.currentTarget.style.background = '#1f2937'; }}
          >
            {props.loading ? t('billing.plan.processing') : t('billing.plan.subscribeBtn')}
          </button>
        )}
      </div>
    </div>
  );
}
