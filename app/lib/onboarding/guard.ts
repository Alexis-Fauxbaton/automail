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
 *
 * The redirect preserves `shop`, `host`, and `embedded` from the incoming
 * request URL. Without them the destination route's authenticate.admin()
 * can't recover the embedded-admin session context and bounces to
 * /auth/login. Pass `request` from the caller; it's optional only so that
 * existing tests that exercise the guard with just a shop string still work.
 */
export async function requireOnboardingComplete(
  shop: string,
  request?: Request,
): Promise<void> {
  const flag = await getShopFlag(shop);
  if (shouldRedirectToOnboarding(flag)) {
    let target = '/app/onboarding';
    if (request) {
      const src = new URL(request.url);
      const params = new URLSearchParams();
      params.set('shop', src.searchParams.get('shop') ?? shop);
      const host = src.searchParams.get('host');
      if (host) params.set('host', host);
      const embedded = src.searchParams.get('embedded');
      if (embedded) params.set('embedded', embedded);
      target += '?' + params.toString();
    }
    throw redirect(target);
  }
}
