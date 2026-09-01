/**
 * Tail-cursor bookkeeping and SSE framing.
 *
 * The worker and the Next server are separate processes, so there is no
 * in-memory bus to subscribe to — the database is the bus, and the stream
 * route polls it. Polling by timestamp alone is subtly wrong: two rows can
 * share a millisecond, and `ts > last` silently drops the second one while
 * `ts >= last` sends the first one twice. The cursor below carries the ids
 * already delivered at its own timestamp, which makes the tail exactly-once
 * without a sequence column.
 *
 * Everything here is pure so it can be tested without a socket or a database.
 */

import type { TelemetryEventRow } from "./types.ts";

export interface TailCursor {
  /** ISO timestamp of the newest row delivered so far. */
  ts: string;
  /** Ids already delivered that carry exactly that timestamp. */
  ids: string[];
}

/** Start from "everything after now" when there is no history to anchor to. */
export function emptyCursor(at: Date = new Date()): TailCursor {
  return { ts: at.toISOString(), ids: [] };
}

/**
 * A cursor positioned just past `rows` (which need not be sorted).
 * Used after the initial backfill so the first poll does not resend it.
 */
export function cursorFrom(rows: readonly TelemetryEventRow[], fallback?: Date): TailCursor {
  if (rows.length === 0) return emptyCursor(fallback);
  let newest = rows[0].ts;
  for (const row of rows) if (row.ts > newest) newest = row.ts;
  return { ts: newest, ids: rows.filter((r) => r.ts === newest).map((r) => r.id) };
}

/**
 * Split a poll's rows into the ones the client has not seen and the cursor to
 * use next time. Feed it everything with `ts >= cursor.ts`; it discards the
 * overlap by id.
 *
 * Output is ordered oldest-first, which is the order the graph animates in.
 */
export function advanceTail(
  cursor: TailCursor,
  rows: readonly TelemetryEventRow[],
): { fresh: TelemetryEventRow[]; cursor: TailCursor } {
  const seen = new Set(cursor.ids);
  const fresh = rows
    .filter((row) => row.ts > cursor.ts || (row.ts === cursor.ts && !seen.has(row.id)))
    .sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1));
  if (fresh.length === 0) return { fresh, cursor };

  const newest = fresh[fresh.length - 1].ts;
  const idsAtNewest = fresh.filter((r) => r.ts === newest).map((r) => r.id);
  // Carry forward the previous ids only when the timestamp has not moved on,
  // otherwise the set would grow without bound on a busy millisecond.
  const ids = newest === cursor.ts ? [...cursor.ids, ...idsAtNewest] : idsAtNewest;
  return { fresh, cursor: { ts: newest, ids } };
}

/**
 * One SSE frame. `data` is JSON on a single line — `sanitizeSummary` has
 * already removed the control characters that would otherwise split a frame,
 * and JSON.stringify escapes any newline that survives inside a string.
 */
export function sseFrame(data: unknown, eventName?: string): string {
  const name = eventName ? `event: ${eventName}\n` : "";
  return `${name}data: ${JSON.stringify(data)}\n\n`;
}

/** A comment frame. Keeps proxies and the browser from closing an idle stream. */
export const SSE_HEARTBEAT = ": heartbeat\n\n";
