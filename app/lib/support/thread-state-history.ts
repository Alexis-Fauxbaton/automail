import type { PrismaClient, Prisma } from "@prisma/client";

type HistoryEntry = {
  shop: string;
  threadId: string;
  fromState: string | null;
  toState: string;
};

export function buildHistoryEntry(params: {
  shop: string;
  threadId: string;
  fromState: string | null;
  toState: string;
}): HistoryEntry | null {
  if (params.fromState === params.toState) return null;
  return {
    shop: params.shop,
    threadId: params.threadId,
    fromState: params.fromState,
    toState: params.toState,
  };
}

export async function recordStateTransition(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: {
    shop: string;
    threadId: string;
    fromState: string | null;
    toState: string;
  }
): Promise<void> {
  const entry = buildHistoryEntry(params);
  if (!entry) return;
  await prisma.threadStateHistory.create({ data: entry });
}
