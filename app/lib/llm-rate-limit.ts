import { checkRateLimit } from "./rate-limit";

// Per-shop daily caps on the manual LLM-triggering actions. These are a
// safety net against:
//   - a misclick loop where a merchant keeps spamming "Refine" / "Regenerate"
//   - a compromised session burning quota in a coordinated attack
//   - a runaway client-side bug that fires the same form multiple times
//
// The numbers are sized so a normal day of heavy usage stays well under the
// cap (rough upper bound: ~15 reanalyse / ~20 refine for the busiest
// merchant we've observed in dogfooding). A merchant who legitimately hits
// the cap can still wait the window out or contact support — that's a
// reasonable cost for catching attacks early.

const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

const LIMITS: Record<LlmActionKind, number> = {
  // Full Tier 3 (intent + Shopify + tracking + draft). Most expensive
  // per call (~5 LLM roundtrips), tightest cap.
  reanalyze: 30,
  // Draft rewrite only. Cheap, but spammable through the inline editor.
  refine: 50,
  // Re-emission of the existing analysis as a fresh draft. Same cost as
  // refine but a different button — separate counter so a heavy
  // re-drafter doesn't starve the refine budget.
  redraft: 30,
};

export type LlmActionKind = "reanalyze" | "refine" | "redraft";

export interface LlmRateLimitMiss {
  rateLimited: {
    kind: LlmActionKind;
    /** Limit applied (events/day). */
    limit: number;
    /** Milliseconds until the 24h window resets. */
    resetMs: number;
  };
}

/**
 * Returns `null` when the call is allowed (you may proceed). Returns a
 * `LlmRateLimitMiss` sentinel when the shop has exceeded its daily budget
 * for the given action — the caller should bail out and surface the
 * sentinel to the UI so the merchant sees a clear message.
 */
export async function checkLlmRateLimit(
  shop: string,
  kind: LlmActionKind,
): Promise<LlmRateLimitMiss | null> {
  const limit = LIMITS[kind];
  const result = await checkRateLimit({
    key: shop,
    kind: `llm-${kind}`,
    limit,
    windowMs: WINDOW_24H_MS,
  });
  if (result.ok) return null;
  const minutesUntilReset = Math.ceil(result.resetMs / 60_000);
  console.warn(
    `[llm-rate-limit] shop=${shop} kind=${kind} hit daily cap (${limit}); ` +
      `resets in ~${minutesUntilReset}min`,
  );
  return {
    rateLimited: { kind, limit, resetMs: result.resetMs },
  };
}
