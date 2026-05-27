import prisma from "../../db.server";
import { getPlan, type PlanId } from "./plans";

export type OverflowSummary = {
  hasOverflow: boolean;
  currentCount: number;
  targetLimit: number;
  toDisconnect: number;     // currentCount - targetLimit (0 if no overflow)
  mailboxes: { id: string; email: string; provider: string }[];
};

export async function computeOverflowForPlanSwitch(opts: {
  shop: string;
  targetPlanId: PlanId;
}): Promise<OverflowSummary> {
  const target = getPlan(opts.targetPlanId);
  if (!target) throw new Error(`Unknown target plan: ${opts.targetPlanId}`);

  const mailboxes = await prisma.mailConnection.findMany({
    where: { shop: opts.shop },
    select: { id: true, email: true, provider: true },
    orderBy: { createdAt: "asc" },
  });
  const currentCount = mailboxes.length;
  const targetLimit = target.maxMailboxes;
  const hasOverflow = currentCount > targetLimit;
  return {
    hasOverflow,
    currentCount,
    targetLimit,
    toDisconnect: hasOverflow ? currentCount - targetLimit : 0,
    mailboxes,
  };
}

export async function resolveOverflowImmediate(opts: {
  shop: string;
  keepMailConnectionId: string;
  targetPlanId: PlanId;
}): Promise<void> {
  const summary = await computeOverflowForPlanSwitch({
    shop: opts.shop,
    targetPlanId: opts.targetPlanId,
  });
  if (!summary.hasOverflow) return;

  // Validate that keepMailConnectionId belongs to this shop and exists
  const keepIds = summary.mailboxes.map((m) => m.id);
  if (!keepIds.includes(opts.keepMailConnectionId)) {
    throw new Error(`Selected mailbox ${opts.keepMailConnectionId} not found for shop ${opts.shop}`);
  }

  const toDelete = summary.mailboxes.filter((m) => m.id !== opts.keepMailConnectionId);
  // Cascade handles all dependent rows
  for (const m of toDelete) {
    await prisma.mailConnection.delete({ where: { id: m.id, shop: opts.shop } });
  }
}
