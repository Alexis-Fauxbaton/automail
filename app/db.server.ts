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

// Best-effort disconnect on process exit. Long-running connections held by
// Prisma's pool may otherwise stay open on the database side until Postgres
// detects them as dead (30-60 s), holding locks and transaction state.
let _disconnectRegistered = false;
function registerDisconnectOnce() {
  if (_disconnectRegistered) return;
  _disconnectRegistered = true;
  const disconnect = () => {
    prisma.$disconnect().catch((err) => console.error("[db] disconnect failed:", err));
  };
  process.once("beforeExit", disconnect);
  process.once("SIGTERM", disconnect);
  process.once("SIGINT", disconnect);
}
registerDisconnectOnce();

export default prisma;
