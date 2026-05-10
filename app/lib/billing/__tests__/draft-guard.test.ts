import { describe, it, expect, vi } from 'vitest';
import { withDraftQuota } from '../draft-guard';

describe('withDraftQuota', () => {
  it('reserves before generation, returns LLM result on success', async () => {
    const reserveImpl = vi.fn().mockResolvedValueOnce({ ok: true, newCount: 12 });
    const releaseImpl = vi.fn().mockResolvedValueOnce(undefined);
    const generator = vi.fn().mockResolvedValue({ draft: 'hello' });

    const result = await withDraftQuota({
      shop: 'test.myshopify.com',
      limit: 50,
      generator,
      reserveImpl,
      releaseImpl,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ draft: 'hello' });
      expect(result.newCount).toBe(12);
    }
    expect(reserveImpl).toHaveBeenCalledOnce();
    expect(generator).toHaveBeenCalledOnce();
    expect(releaseImpl).not.toHaveBeenCalled();
  });

  it('returns quota_exceeded without calling generator', async () => {
    const reserveImpl = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'quota_exceeded' });
    const releaseImpl = vi.fn();
    const generator = vi.fn();

    const result = await withDraftQuota({
      shop: 'test.myshopify.com',
      limit: 50,
      generator,
      reserveImpl,
      releaseImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('quota_exceeded');
    expect(generator).not.toHaveBeenCalled();
  });

  it('releases the reservation if generator throws', async () => {
    const reserveImpl = vi.fn().mockResolvedValueOnce({ ok: true, newCount: 5 });
    const releaseImpl = vi.fn().mockResolvedValueOnce(undefined);
    const generator = vi.fn().mockRejectedValue(new Error('LLM down'));

    const result = await withDraftQuota({
      shop: 'test.myshopify.com',
      limit: 50,
      generator,
      reserveImpl,
      releaseImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('generator_failed');
    expect(releaseImpl).toHaveBeenCalledOnce();
  });

  it('still returns failure if release itself throws (best-effort)', async () => {
    const reserveImpl = vi.fn().mockResolvedValueOnce({ ok: true, newCount: 5 });
    const releaseImpl = vi.fn().mockRejectedValueOnce(new Error('DB down'));
    const generator = vi.fn().mockRejectedValue(new Error('LLM down'));

    const result = await withDraftQuota({
      shop: 'test.myshopify.com',
      limit: 50,
      generator,
      reserveImpl,
      releaseImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('generator_failed');
  });
});
