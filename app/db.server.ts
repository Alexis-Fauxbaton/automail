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

export default prisma;
