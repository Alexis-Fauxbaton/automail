import { redirect } from 'react-router';
import { getShopFlag } from './repo';
import { isOnboardingComplete, type ShopFlagLike } from './state';

export function shouldRedirectToOnboarding(flag: ShopFlagLike | null): boolean {
  return !isOnboardingComplete(flag);
}

/**
 * Use inside route loaders that require completed onboarding. Throws a
 * redirect to /app/onboarding if onboarding is not complete; otherwise
 * returns silently.
 */
export async function requireOnboardingComplete(shop: string): Promise<void> {
  const flag = await getShopFlag(shop);
  if (shouldRedirectToOnboarding(flag)) {
    throw redirect('/app/onboarding');
  }
}
