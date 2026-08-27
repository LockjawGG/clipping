import { PrismaClient } from "@prisma/client";

/**
 * A single PrismaClient per process. Next.js dev mode re-evaluates modules on
 * every change, so without the global cache each reload would open a new pool
 * and Postgres would run out of connections.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
