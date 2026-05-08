/**
 * Catch-up helpers — used when auto-sync resumes after a suspend
 * (post-upgrade or post-period-reset).
 *
 * Zone active : messages received in the last 48 hours go through the
 * full analysis pipeline (intent + identifiers + tracking) at import
 * time — no draft generated. This makes the inbox immediately useful
 * without consuming quota.
 *
 * Zone hors-fenêtre : older messages are imported but Tier 2 + Tier 3
 * are skipped. They surface in the "À analyser" / "À traiter" bucket
 * with a "non-analysé" state. Merchant clicks "Generate draft" to
 * trigger the full pipeline + draft = 1 quota unit.
 */

export const ACTIVE_ZONE_HOURS = 48;

const ACTIVE_ZONE_MS = ACTIVE_ZONE_HOURS * 60 * 60 * 1000;

/**
 * True when `receivedAt` falls within the active 48h window relative
 * to `now`. Future timestamps (clock skew) are treated as within zone
 * so they don't get accidentally downgraded.
 */
export function isWithin48hZone(receivedAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - receivedAt.getTime();
  return ageMs < ACTIVE_ZONE_MS;
}
