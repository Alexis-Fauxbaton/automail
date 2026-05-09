/**
 * Trial state derivation. Pure functions — no DB, no network.
 *
 * Trial duration is read from the plans catalog. The caller passes
 * the shop's firstInstallDate (looked up from ShopFlag) and the
 * current time; we derive whether the trial is still active and how
 * many days remain.
 */

import { PLANS } from './plans';

const DAY_MS = 24 * 60 * 60 * 1000;

export type TrialStatus = 'active' | 'expired';

export interface TrialState {
  status: TrialStatus;
  /** Days remaining (always >= 0). 0 means expired. Sub-day remainders round up. */
  daysRemaining: number;
  /** Exact moment the trial ends. */
  expiresAt: Date;
}

export interface ComputeTrialStateInput {
  firstInstallDate: Date;
  now: Date;
}

export function computeTrialState({ firstInstallDate, now }: ComputeTrialStateInput): TrialState {
  const durationDays = PLANS.trial.durationDays ?? 14;
  const expiresAt = new Date(firstInstallDate.getTime() + durationDays * DAY_MS);
  const remainingMs = expiresAt.getTime() - now.getTime();

  if (remainingMs <= 0) {
    return { status: 'expired', daysRemaining: 0, expiresAt };
  }

  return {
    status: 'active',
    daysRemaining: Math.ceil(remainingMs / DAY_MS),
    expiresAt,
  };
}
