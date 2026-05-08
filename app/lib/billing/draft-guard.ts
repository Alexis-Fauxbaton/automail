/**
 * Standardized wrapper around any LLM call that produces a billable draft.
 *
 * Pattern:
 *   1. Reserve 1 unit (atomic CAS via tryReserveDraft).
 *      - If quota exceeded → return structured error, no LLM call.
 *   2. Run the generator.
 *      - On success → return value + new count.
 *      - On failure → release the reservation, return structured error.
 *
 * Caller (route action / inbox-actions handler) translates the structured
 * error into HTTP/UI:
 *   - quota_exceeded → 402 + modal "Quota reached"
 *   - generator_failed → 500 + retry / error toast
 *
 * The reserveImpl / releaseImpl injections are for testing; production
 * callers omit them and the defaults are used.
 */

import {
  tryReserveDraft as defaultReserve,
  releaseDraft as defaultRelease,
} from "./usage";

export type DraftGuardResult<T> =
  | { ok: true; value: T; newCount: number }
  | { ok: false; reason: 'quota_exceeded' | 'generator_failed'; error?: unknown };

interface ReserveImpl {
  (input: { shop: string; limit: number; now?: Date }):
    Promise<{ ok: true; newCount: number } | { ok: false; reason: 'quota_exceeded' }>;
}
interface ReleaseImpl {
  (input: { shop: string; now?: Date }): Promise<void>;
}

export async function withDraftQuota<T>(input: {
  shop: string;
  limit: number;
  generator: () => Promise<T>;
  reserveImpl?: ReserveImpl;
  releaseImpl?: ReleaseImpl;
}): Promise<DraftGuardResult<T>> {
  const reserve = input.reserveImpl ?? defaultReserve;
  const release = input.releaseImpl ?? defaultRelease;

  const reserveResult = await reserve({ shop: input.shop, limit: input.limit });
  if (!reserveResult.ok) {
    return { ok: false, reason: 'quota_exceeded' };
  }

  try {
    const value = await input.generator();
    return { ok: true, value, newCount: reserveResult.newCount };
  } catch (err) {
    try {
      await release({ shop: input.shop });
    } catch (releaseErr) {
      console.error(`[billing] release after failed generator failed for ${input.shop}:`, releaseErr);
    }
    return { ok: false, reason: 'generator_failed', error: err };
  }
}
