import { describe, it, expect } from 'vitest';
import { isWithinActiveZone, ACTIVE_ZONE_HOURS } from '../catchup';

const HOUR_MS = 60 * 60 * 1000;

describe('isWithinActiveZone', () => {
  const now = new Date('2026-05-09T12:00:00Z');

  it('true for a message from 1h ago', () => {
    const receivedAt = new Date(now.getTime() - 1 * HOUR_MS);
    expect(isWithinActiveZone(receivedAt, now)).toBe(true);
  });

  it('true for a message from ACTIVE_ZONE_HOURS - 1', () => {
    const receivedAt = new Date(now.getTime() - (ACTIVE_ZONE_HOURS - 1) * HOUR_MS);
    expect(isWithinActiveZone(receivedAt, now)).toBe(true);
  });

  it('false at exactly ACTIVE_ZONE_HOURS', () => {
    const receivedAt = new Date(now.getTime() - ACTIVE_ZONE_HOURS * HOUR_MS);
    expect(isWithinActiveZone(receivedAt, now)).toBe(false);
  });

  it('false for a message from ACTIVE_ZONE_HOURS + 24 ago', () => {
    const receivedAt = new Date(now.getTime() - (ACTIVE_ZONE_HOURS + 24) * HOUR_MS);
    expect(isWithinActiveZone(receivedAt, now)).toBe(false);
  });

  it('treats future timestamps as within zone (clock skew safety)', () => {
    const receivedAt = new Date(now.getTime() + 10 * 60 * 1000);
    expect(isWithinActiveZone(receivedAt, now)).toBe(true);
  });

  it('exposes ACTIVE_ZONE_HOURS as a constant matching the current spec', () => {
    expect(ACTIVE_ZONE_HOURS).toBe(72);
  });
});
