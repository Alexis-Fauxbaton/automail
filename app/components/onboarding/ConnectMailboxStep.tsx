import type { TFunction } from 'i18next';

interface Props {
  gmailAuthUrl: string | null;
  zohoAuthUrl: string | null;
  outlookAuthUrl: string | null;
  t: TFunction;
}

export function ConnectMailboxStep({ gmailAuthUrl, zohoAuthUrl, outlookAuthUrl, t }: Props) {
  return (
    <s-page>
      <s-section heading={t('onboarding.connect.title')}>
        <s-paragraph>{t('onboarding.connect.body')}</s-paragraph>
        <s-stack direction="inline" gap="base">
          {gmailAuthUrl && (
            <s-button variant="primary" onClick={() => { window.top!.location.href = gmailAuthUrl; }}>
              {t('onboarding.connect.gmail')}
            </s-button>
          )}
          {outlookAuthUrl && (
            <s-button variant="secondary" onClick={() => { window.top!.location.href = outlookAuthUrl; }}>
              {t('onboarding.connect.outlook')}
            </s-button>
          )}
          {zohoAuthUrl && (
            <s-button variant="secondary" onClick={() => { window.top!.location.href = zohoAuthUrl; }}>
              {t('onboarding.connect.zoho')}
            </s-button>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
