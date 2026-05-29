import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

// In production: module cache ensures a single instance per process.
// In development: store on global so HMR doesn't open a new connection on every reload.
const prisma = global.prismaGlobal ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prismaGlobal = prisma;
}

// Best-effort disconnect on Node's `beforeExit` ONLY. We intentionally do
// NOT subscribe to SIGTERM/SIGINT here — those are owned by the graceful
// shutdown handler in `entry.server.tsx`, which needs Prisma alive until
// the auto-sync loop has drained. If we listened here too, the disconnect
// would fire BEFORE the drain (registration order: this file imports
// first), leaving the drain code talking to a closed pool.
//
// `beforeExit` fires when Node has nothing left to do — it never fires
// when entry.server.tsx calls `process.exit(0)`, so this listener mostly
// catches one-off scripts / dev workflows. The SIGTERM path explicitly
// calls `prisma.$disconnect()` at the end of its handler.
process.once("beforeExit", () => {
  prisma.$disconnect().catch((err) => console.error("[db] disconnect failed:", err));
});

export default prisma;
