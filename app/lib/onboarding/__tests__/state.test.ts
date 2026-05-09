import { describe, it, expect } from 'vitest';
import {
  isOnboardingComplete,
  isChecklistDismissed,
  deriveChecklistState,
  type ShopFlagLike,
  type ChecklistInputs,
} from '../state';

const baseFlag: ShopFlagLike = {
  shop: 's.myshopify.com',
  onboardingCompletedAt: null,
  checklistDismissedAt: null,
};

describe('isOnboardingComplete', () => {
  it('returns false when flag is null', () => {
    expect(isOnboardingComplete(null)).toBe(false);
  });
  it('returns false when onboardingCompletedAt is null', () => {
    expect(isOnboardingComplete(baseFlag)).toBe(false);
  });
  it('returns true when onboardingCompletedAt is set', () => {
    expect(isOnboardingComplete({ ...baseFlag, onboardingCompletedAt: new Date() })).toBe(true);
  });
});

describe('isChecklistDismissed', () => {
  it('returns false when flag is null', () => {
    expect(isChecklistDismissed(null)).toBe(false);
  });
  it('returns false when checklistDismissedAt is null', () => {
    expect(isChecklistDismissed(baseFlag)).toBe(false);
  });
  it('returns true when checklistDismissedAt is set', () => {
    expect(isChecklistDismissed({ ...baseFlag, checklistDismissedAt: new Date() })).toBe(true);
  });
});

describe('deriveChecklistState', () => {
  const inputs: ChecklistInputs = {
    hasDraft: false,
    hasCustomizedSettings: false,
  };

  it('marks both items unchecked when nothing is done', () => {
    const state = deriveChecklistState(inputs);
    expect(state.firstDraft).toBe(false);
    expect(state.toneAndSignature).toBe(false);
    expect(state.completedCount).toBe(0);
    expect(state.totalCount).toBe(2);
    expect(state.allComplete).toBe(false);
  });

  it('marks firstDraft checked when hasDraft is true', () => {
    const state = deriveChecklistState({ ...inputs, hasDraft: true });
    expect(state.firstDraft).toBe(true);
    expect(state.completedCount).toBe(1);
    expect(state.allComplete).toBe(false);
  });

  it('marks toneAndSignature checked when hasCustomizedSettings is true', () => {
    const state = deriveChecklistState({ ...inputs, hasCustomizedSettings: true });
    expect(state.toneAndSignature).toBe(true);
    expect(state.completedCount).toBe(1);
  });

  it('marks all complete when both inputs are true', () => {
    const state = deriveChecklistState({ hasDraft: true, hasCustomizedSettings: true });
    expect(state.allComplete).toBe(true);
    expect(state.completedCount).toBe(2);
  });
});
