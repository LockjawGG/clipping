/**
 * Reading the event store back out.
 *
 * Two consumers, one query shape: the SSE route tails forward from a cursor,
 * the history route replays a window. Both go through `toEventRow` so the
 * browser sees exactly one representation — in particular `ts` as an ISO
 * string, since a Date does not survive JSON and the client sorts on it.
 *
 * `import type` only, so nothing here pulls the generated client in at runtime
 * and the query-parsing helper stays testable on its own.
 */

import type { PrismaClient } from "@prisma/client";

import type { TelemetryEventRow } from "./types.ts";

/** How much history a freshly connected stream is given for context. */
export const TAIL_BACKFILL = 100;
/** Default history window: long enough to cover a working session. */
export const HISTORY_DEFAULT_WINDOW_MS = 4 * 60 * 60_000;
/** Hard ceiling on one history response. */
export const HISTORY_MAX_ROWS = 2000;
/** Most rows one poll of the tail will carry. Bursts spill to the next tick. */
export const TAIL_MAX_ROWS = 500;

type Row = {
  id: string;
  ts: Date;
  source: string;
  eventType: string;
  actor: string;
  targetActor: string | null;
  taskId: string | null;
  summary: string;
  status: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedTokensAvoided: number | null;
  latencyMs: number | null;
  model: string | null;
  metaJson: string | null;
};

export function toEventRow(row: Row): TelemetryEventRow {
  return { ...row, ts: row.ts.toISOString() };
}

export interface HistoryQuery {
  since: Date;
  limit: number;
}

/**
 * Parse `?since=&limit=`. Pure, and forgiving in one direction only: a bad
 * value falls back to the default rather than erroring, but nothing can push
 * the limit past `HISTORY_MAX_ROWS` or the window into the future.
 */
export function parseHistoryQuery(
  params: URLSearchParams,
  now: number = Date.now(),
): HistoryQuery {
  const rawSince = params.get("since");
  let since = new Date(now - HISTORY_DEFAULT_WINDOW_MS);
  if (rawSince) {
    const parsed = new Date(rawSince);
    // A `since` in the future would return nothing and look like a broken
    // page rather than a bad query, so it is clamped to now.
    if (!Number.isNaN(parsed.getTime())) {
      since = new Date(Math.min(parsed.getTime(), now));
    }
  }

  const rawLimit = Number(params.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), HISTORY_MAX_ROWS)
      : HISTORY_MAX_ROWS;

  return { since, limit };
}

/**
 * A window of history, oldest first.
 *
 * The `take` is applied to a newest-first query and the result reversed, so a
 * window with more rows than the limit keeps the *most recent* ones — a
 * truncated history that stops halfway through the window would look like the
 * machine went quiet.
 */
export async function readHistory(
  db: PrismaClient,
  query: HistoryQuery,
): Promise<TelemetryEventRow[]> {
  const rows = await db.telemetryEvent.findMany({
    where: { ts: { gte: query.since } },
    orderBy: { ts: "desc" },
    take: query.limit,
  });
  return rows.map(toEventRow).reverse();
}

/** The newest `limit` events, oldest first — a stream's opening backfill. */
export async function readTailBackfill(
  db: PrismaClient,
  limit: number = TAIL_BACKFILL,
): Promise<TelemetryEventRow[]> {
  const rows = await db.telemetryEvent.findMany({ orderBy: { ts: "desc" }, take: limit });
  return rows.map(toEventRow).reverse();
}

/**
 * Everything at or after `since`, oldest first.
 *
 * Inclusive on purpose: the caller's `TailCursor` discards the overlap by id,
 * which is what makes rows sharing a millisecond neither duplicated nor lost.
 */
export async function readSince(
  db: PrismaClient,
  since: Date,
  limit: number = TAIL_MAX_ROWS,
): Promise<TelemetryEventRow[]> {
  const rows = await db.telemetryEvent.findMany({
    where: { ts: { gte: since } },
    orderBy: { ts: "asc" },
    take: limit,
  });
  return rows.map(toEventRow);
}
