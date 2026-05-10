import { describe, it, expect } from 'vitest';
import { computeTrialState } from '../trial';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('computeTrialState', () => {
  const now = new Date('2026-05-08T12:00:00Z');

  it('returns active with 14 days remaining when install just happened', () => {
    const firstInstallDate = new Date(now.getTime() - 1000); // 1 second ago
    const result = computeTrialState({ firstInstallDate, now });
    expect(result.status).toBe('active');
    expect(result.daysRemaining).toBe(14);
    expect(result.expiresAt.getTime()).toBe(firstInstallDate.getTime() + 14 * DAY_MS);
  });

  it('returns active with 7 days remaining when 7 days passed', () => {
    const firstInstallDate = new Date(now.getTime() - 7 * DAY_MS);
    const result = computeTrialState({ firstInstallDate, now });
    expect(result.status).toBe('active');
    expect(result.daysRemaining).toBe(7);
  });

  it('returns active with 1 day remaining at day 13', () => {
    const firstInstallDate = new Date(now.getTime() - 13 * DAY_MS);
    const result = computeTrialState({ firstInstallDate, now });
    expect(result.status).toBe('active');
    expect(result.daysRemaining).toBe(1);
  });

  it('returns expired exactly at 14 days', () => {
    const firstInstallDate = new Date(now.getTime() - 14 * DAY_MS);
    const result = computeTrialState({ firstInstallDate, now });
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBe(0);
  });

  it('returns expired well after 14 days', () => {
    const firstInstallDate = new Date(now.getTime() - 30 * DAY_MS);
    const result = computeTrialState({ firstInstallDate, now });
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBe(0);
  });

  it('rounds daysRemaining up so that "1 day left" displays for any sub-day remainder', () => {
    // 13.5 days passed → 0.5 day remaining → ceil(0.5) = 1
    const firstInstallDate = new Date(now.getTime() - 13.5 * DAY_MS);
    const result = computeTrialState({ firstInstallDate, now });
    expect(result.daysRemaining).toBe(1);
  });
});
