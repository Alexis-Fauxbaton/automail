import { describe, it, expect } from 'vitest';
import { isWithin48hZone, ACTIVE_ZONE_HOURS } from '../catchup';

const HOUR_MS = 60 * 60 * 1000;

describe('isWithin48hZone', () => {
  const now = new Date('2026-05-09T12:00:00Z');

  it('true for a message from 1h ago', () => {
    const receivedAt = new Date(now.getTime() - 1 * HOUR_MS);
    expect(isWithin48hZone(receivedAt, now)).toBe(true);
  });

  it('true for a message from 47h ago', () => {
    const receivedAt = new Date(now.getTime() - 47 * HOUR_MS);
    expect(isWithin48hZone(receivedAt, now)).toBe(true);
  });

  it('false at exactly 48h', () => {
    const receivedAt = new Date(now.getTime() - 48 * HOUR_MS);
    expect(isWithin48hZone(receivedAt, now)).toBe(false);
  });

  it('false for a message from 72h ago', () => {
    const receivedAt = new Date(now.getTime() - 72 * HOUR_MS);
    expect(isWithin48hZone(receivedAt, now)).toBe(false);
  });

  it('treats future timestamps as within zone (clock skew safety)', () => {
    const receivedAt = new Date(now.getTime() + 10 * 60 * 1000);
    expect(isWithin48hZone(receivedAt, now)).toBe(true);
  });

  it('exposes ACTIVE_ZONE_HOURS as a constant', () => {
    expect(ACTIVE_ZONE_HOURS).toBe(48);
  });
});
