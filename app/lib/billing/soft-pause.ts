import prisma from "../../db.server";
import { getPlan, type PlanId } from "./plans";

/**
 * Detect whether the shop currently has more mailboxes than its active plan
 * allows. If so, set autoSyncEnabled=false on ALL mailboxes (no arbitrary
 * choice). Idempotent — calling twice is a no-op.
 *
 * Returns the number of mailboxes that got paused (0 if no overflow or
 * already paused).
 */
export async function applySoftPauseIfOverflow(opts: {
  shop: string;
  activePlanId: PlanId;
}): Promise<number> {
  const plan = getPlan(opts.activePlanId);
  if (!plan) throw new Error(`Unknown plan: ${opts.activePlanId}`);

  const all = await prisma.mailConnection.findMany({
    where: { shop: opts.shop },
    select: { id: true, autoSyncEnabled: true },
  });
  if (all.length <= plan.maxMailboxes) return 0;

  // Overflow detected. Pause every mailbox that's still active.
  const toPause = all.filter((m) => m.autoSyncEnabled).map((m) => m.id);
  if (toPause.length === 0) return 0;

  await prisma.mailConnection.updateMany({
    where: { shop: opts.shop, id: { in: toPause } },
    data: { autoSyncEnabled: false },
  });
  return toPause.length;
}
