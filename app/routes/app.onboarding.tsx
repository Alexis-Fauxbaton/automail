import type { LoaderFunctionArgs } from 'react-router';
import { redirect, useLoaderData, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { authenticate } from '../shopify.server';
import prisma from '../db.server';
import { getShopFlag, markOnboardingComplete } from '../lib/onboarding/repo';
import { isOnboardingComplete } from '../lib/onboarding/state';
import { getAuthUrl as getGmailAuthUrl } from '../lib/gmail/auth';
import { getZohoAuthUrl } from '../lib/zoho/auth';
import { getAuthUrl as getOutlookAuthUrl } from '../lib/outlook/auth';
import { WelcomeStep } from '../components/onboarding/WelcomeStep';
import { ConnectMailboxStep } from '../components/onboarding/ConnectMailboxStep';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Already onboarded → never show the wizard again.
  const flag = await getShopFlag(shop);
  if (isOnboardingComplete(flag)) {
    throw redirect('/app/inbox');
  }

  // Mailbox already connected (e.g. user came back from OAuth) → mark
  // onboarding complete and redirect.
  const mailboxCount = await prisma.mailConnection.count({ where: { shop } });
  if (mailboxCount > 0) {
    await markOnboardingComplete(shop);
    throw redirect('/app/inbox');
  }

  let gmailAuthUrl: string | null = null;
  let zohoAuthUrl: string | null = null;
  let outlookAuthUrl: string | null = null;
  try { gmailAuthUrl = getGmailAuthUrl(shop); } catch { /* creds not configured */ }
  try { zohoAuthUrl = getZohoAuthUrl(shop); } catch { /* creds not configured */ }
  try { outlookAuthUrl = getOutlookAuthUrl(shop); } catch { /* creds not configured */ }

  return { gmailAuthUrl, zohoAuthUrl, outlookAuthUrl };
};

export default function OnboardingPage() {
  const { gmailAuthUrl, zohoAuthUrl, outlookAuthUrl } = useLoaderData<typeof loader>();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const step = searchParams.get('step') === 'connect' ? 'connect' : 'welcome';

  if (step === 'welcome') {
    return <WelcomeStep onContinue={() => setSearchParams({ step: 'connect' })} t={t} />;
  }

  return (
    <ConnectMailboxStep
      gmailAuthUrl={gmailAuthUrl}
      zohoAuthUrl={zohoAuthUrl}
      outlookAuthUrl={outlookAuthUrl}
      t={t}
    />
  );
}
