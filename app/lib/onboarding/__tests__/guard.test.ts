import { describe, it, expect } from 'vitest';
import { shouldRedirectToOnboarding } from '../guard';

describe('shouldRedirectToOnboarding', () => {
  it('returns false when onboardingCompletedAt is set', () => {
    expect(
      shouldRedirectToOnboarding({
        shop: 's',
        onboardingCompletedAt: new Date(),
        checklistDismissedAt: null,
      }),
    ).toBe(false);
  });

  it('returns true when flag exists but onboardingCompletedAt is null', () => {
    expect(
      shouldRedirectToOnboarding({
        shop: 's',
        onboardingCompletedAt: null,
        checklistDismissedAt: null,
      }),
    ).toBe(true);
  });

  it('returns true when flag is null (no row yet)', () => {
    expect(shouldRedirectToOnboarding(null)).toBe(true);
  });
});
