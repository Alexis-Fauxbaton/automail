import { describe, it, expect } from 'vitest';
import { PLANS, getPlan, type PlanId } from '../plans';

describe('plans catalog', () => {
  it('exposes starter and pro plans', () => {
    expect(PLANS.starter).toBeDefined();
    expect(PLANS.pro).toBeDefined();
  });

  it('starter plan has expected limits', () => {
    expect(PLANS.starter.id).toBe('starter');
    expect(PLANS.starter.priceUsd).toBe(9);
    expect(PLANS.starter.analyzedThreadsPerMonth).toBe(50);
    expect(PLANS.starter.maxMailboxes).toBe(1);
    expect(PLANS.starter.advancedDashboard).toBe(false);
    expect(PLANS.starter.dashboardMaxRangeDays).toBe(7);
  });

  it('pro plan has expected limits', () => {
    expect(PLANS.pro.id).toBe('pro');
    expect(PLANS.pro.priceUsd).toBe(49);
    expect(PLANS.pro.analyzedThreadsPerMonth).toBe(500);
    expect(PLANS.pro.maxMailboxes).toBe(3);
    expect(PLANS.pro.advancedDashboard).toBe(true);
    expect(PLANS.pro.dashboardMaxRangeDays).toBe(90);
  });

  it('trial plan grants pro-level access for 14 days', () => {
    expect(PLANS.trial.analyzedThreadsPerMonth).toBe(Infinity);
    expect(PLANS.trial.maxMailboxes).toBe(3);
    expect(PLANS.trial.advancedDashboard).toBe(true);
    expect(PLANS.trial.dashboardMaxRangeDays).toBe(90);
    expect(PLANS.trial.durationDays).toBe(14);
  });

  it('getPlan returns the right entry by id', () => {
    expect(getPlan('starter')).toBe(PLANS.starter);
    expect(getPlan('pro')).toBe(PLANS.pro);
    expect(getPlan('trial')).toBe(PLANS.trial);
  });

  it('getPlan returns null for unknown id', () => {
    // @ts-expect-error — testing runtime fallback for invalid id
    expect(getPlan('enterprise')).toBeNull();
  });
});
