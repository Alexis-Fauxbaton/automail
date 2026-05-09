export interface ShopFlagLike {
  shop: string;
  onboardingCompletedAt: Date | null;
  checklistDismissedAt: Date | null;
}

export interface ChecklistInputs {
  hasDraft: boolean;
  hasCustomizedSettings: boolean;
}

export interface ChecklistState {
  firstDraft: boolean;
  toneAndSignature: boolean;
  completedCount: number;
  totalCount: number;
  allComplete: boolean;
}

export function isOnboardingComplete(flag: ShopFlagLike | null): boolean {
  return !!flag?.onboardingCompletedAt;
}

export function isChecklistDismissed(flag: ShopFlagLike | null): boolean {
  return !!flag?.checklistDismissedAt;
}

export function deriveChecklistState(inputs: ChecklistInputs): ChecklistState {
  const firstDraft = inputs.hasDraft;
  const toneAndSignature = inputs.hasCustomizedSettings;
  const completedCount = (firstDraft ? 1 : 0) + (toneAndSignature ? 1 : 0);
  const totalCount = 2;
  return {
    firstDraft,
    toneAndSignature,
    completedCount,
    totalCount,
    allComplete: completedCount === totalCount,
  };
}
