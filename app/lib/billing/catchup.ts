/**
 * Catch-up helpers — used when auto-sync resumes after a suspend
 * (post-upgrade or post-period-reset).
 *
 * Zone active : messages received in the last 72 hours go through the
 * full analysis pipeline (intent + identifiers + tracking) at import
 * time. The window covers a normal weekend (Friday evening → Monday
 * morning ≈ 60 h) so merchants who don't check email over the weekend
 * still find the active inbox auto-processed on Monday.
 *
 * Zone hors-fenêtre : older messages are imported but Tier 2 + Tier 3
 * are skipped. They surface in the "À analyser" / "À traiter" bucket
 * with a "non-analysé" state. Merchant clicks "Generate draft" to
 * trigger the full pipeline + draft = 1 quota unit.
 */

export const ACTIVE_ZONE_HOURS = 72;

const ACTIVE_ZONE_MS = ACTIVE_ZONE_HOURS * 60 * 60 * 1000;

/**
 * True when `receivedAt` falls within the active catch-up window
 * relative to `now`. Future timestamps (clock skew) are treated as
 * within zone so they don't get accidentally downgraded.
 */
export function isWithinActiveZone(receivedAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - receivedAt.getTime();
  return ageMs < ACTIVE_ZONE_MS;
}
