import { Prisma, type PrismaClient } from "@prisma/client";

import type { JobKind, JobRecord, JobStore } from "./types.ts";

type JobRow = {
  id: string;
  videoId: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  progress: number;
  payload: Prisma.JsonValue;
  runAfter: Date;
};

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    videoId: row.videoId,
    kind: row.kind as JobKind,
    status: row.status as JobRecord["status"],
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    progress: row.progress,
    payload: row.payload,
    runAfter: row.runAfter,
  };
}

const asJson = (value: unknown): Prisma.InputJsonValue =>
  (value ?? {}) as Prisma.InputJsonValue;

/** A `JobStore` backed by the Prisma `Job` model. */
export function createPrismaJobStore(db: PrismaClient): JobStore {
  return {
    async claimable(now, limit) {
      const rows = await db.job.findMany({
        where: { status: "QUEUED", runAfter: { lte: now } },
        orderBy: { runAfter: "asc" },
        take: limit,
      });
      return rows.map(toRecord);
    },

    async claim(id) {
      // Compare-and-swap: only the worker that flips QUEUED->PROCESSING owns it.
      const res = await db.job.updateMany({
        where: { id, status: "QUEUED" },
        data: { status: "PROCESSING", attempts: { increment: 1 }, progress: 0 },
      });
      if (res.count === 0) return null;
      const row = await db.job.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async complete(id, result) {
      await db.job.update({
        where: { id },
        data: { status: "COMPLETED", progress: 1, result: asJson(result), errorMessage: null },
      });
    },

    async fail(id, errorMessage) {
      await db.job.update({
        where: { id },
        data: { status: "FAILED", errorMessage: errorMessage.slice(0, 2000) },
      });
    },

    async retry(id, runAfter) {
      await db.job.update({
        where: { id },
        data: { status: "QUEUED", runAfter },
      });
    },

    async setProgress(id, fraction) {
      await db.job.update({ where: { id }, data: { progress: fraction } });
    },

    async heartbeat(id) {
      // `@updatedAt` bumps on any write; touch a cheap column.
      await db.job.updateMany({ where: { id, status: "PROCESSING" }, data: { progress: { increment: 0 } } });
    },

    async reclaimStale(staleBefore) {
      // A job in PROCESSING with a dead heartbeat means its worker vanished
      // (crash, kill, deploy) — the attempt never really ran, so hand it back
      // with a fresh attempt budget rather than burning one each time.
      const res = await db.job.updateMany({
        where: { status: "PROCESSING", updatedAt: { lt: staleBefore } },
        data: { status: "QUEUED", runAfter: new Date(), attempts: 0, progress: 0, errorMessage: null },
      });
      return res.count;
    },
  };
}

export interface EnqueueInput {
  videoId: string;
  kind: JobKind;
  payload?: unknown;
  runAfter?: Date;
  maxAttempts?: number;
}

/** Insert a QUEUED job. */
export async function enqueueJob(db: PrismaClient, input: EnqueueInput): Promise<string> {
  const job = await db.job.create({
    data: {
      videoId: input.videoId,
      kind: input.kind,
      payload: input.payload === undefined ? Prisma.JsonNull : asJson(input.payload),
      ...(input.runAfter ? { runAfter: input.runAfter } : {}),
      ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
    },
  });
  return job.id;
}
