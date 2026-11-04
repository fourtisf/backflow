import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __backflowPrisma?: PrismaClient };

/**
 * Shared Prisma client. One instance per process; reused across hot reloads in dev.
 */
export function getPrisma(): PrismaClient {
  if (!globalForPrisma.__backflowPrisma) {
    globalForPrisma.__backflowPrisma = new PrismaClient({
      log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"],
    });
  }
  return globalForPrisma.__backflowPrisma;
}
export * from "./dto";
export * as admin from "./admin";
