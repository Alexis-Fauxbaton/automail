// Dashboard statistics helpers — period bounds computation and DB query stubs.
// Task 7 will add the DB query functions; this module already provides getPeriodBounds
// as a pure function so it can be unit-tested without a database connection.

export type PeriodBounds = {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
};

const RANGE_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export function getPeriodBounds(
  range: string,
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date()
): PeriodBounds {
  let start: Date;
  let end: Date;

  if (range === "custom" && from && to) {
    start = new Date(from);
    end = new Date(to);
  } else {
    const ms = RANGE_MS[range] ?? RANGE_MS["30d"];
    end = now;
    start = new Date(now.getTime() - ms);
  }

  const duration = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime());
  const prevStart = new Date(start.getTime() - duration);

  return { start, end, prevStart, prevEnd };
}

// DB query functions (Task 7) will be added here.
// They use a lazy prisma import to avoid instantiating PrismaClient at module load
// time — this keeps getPeriodBounds unit-testable without a database connection.
//
// Pattern for Task 7:
//   async function queryFoo(shop: string, bounds: PeriodBounds) {
//     const { default: prisma } = await import("../db.server");
//     return prisma.someModel.findMany({ where: { shop, ... } });
//   }
