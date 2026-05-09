import type { TFunction } from 'i18next';

interface Props {
  onContinue: () => void;
  t: TFunction;
}

export function WelcomeStep({ onContinue, t }: Props) {
  return (
    <s-page>
      <s-section heading={t('onboarding.welcome.title')}>
        <s-paragraph>{t('onboarding.welcome.body')}</s-paragraph>
        <s-button variant="primary" onClick={onContinue}>
          {t('onboarding.welcome.cta')}
        </s-button>
      </s-section>
    </s-page>
  );
}
