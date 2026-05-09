import { useFetcher } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { ChecklistState } from '../../lib/onboarding/state';

interface Props {
  state: ChecklistState;
  dismissed: boolean;
}

export function OnboardingChecklist({ state, dismissed }: Props) {
  const { t } = useTranslation();
  const fetcher = useFetcher();

  // Hide if dismissed, or if all complete (auto-hide on next visit).
  if (dismissed || state.allComplete) return null;

  const onDismiss = () => {
    fetcher.submit({}, { method: 'POST', action: '/api/onboarding/dismiss-checklist' });
  };

  return (
    <s-box padding="large-300" borderWidth="base" borderRadius="large-200" background="subdued">
      <s-stack direction="block" gap="base">
        <s-heading>{t('onboarding.checklist.title')}</s-heading>
        <s-paragraph>
          {t('onboarding.checklist.progress', { done: state.completedCount, total: state.totalCount })}
        </s-paragraph>
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            <span aria-hidden>{state.firstDraft ? '✅' : '⬜'}</span>{' '}
            {t('onboarding.checklist.firstDraft')}
          </s-paragraph>
          <s-paragraph>
            <span aria-hidden>{state.toneAndSignature ? '✅' : '⬜'}</span>{' '}
            <a href="/app/settings">{t('onboarding.checklist.toneAndSignature')}</a>
          </s-paragraph>
        </s-stack>
        <s-button onClick={onDismiss}>{t('onboarding.checklist.dismiss')}</s-button>
      </s-stack>
    </s-box>
  );
}
