import { route } from "@/lib/api/http.ts";
import { db } from "@/lib/db.ts";
import { requireUserId } from "@/lib/auth/session.ts";
import { readSince, readTailBackfill } from "@/lib/telemetry/read.ts";
import { SSE_HEARTBEAT, advanceTail, cursorFrom, sseFrame, type TailCursor } from "@/lib/telemetry/stream.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often the tail is checked. Fast enough to feel live, slow enough that an
 *  idle page is one trivial indexed query a second. */
const POLL_MS = 1_000;
/** Comment frames keep proxies and the browser from dropping an idle stream. */
const HEARTBEAT_MS = 15_000;

/**
 * GET /api/telemetry/stream — server-sent events for the Agent Brain page.
 *
 * The tail is read from the database rather than from an in-memory bus because
 * the producers are in different processes: the ingest worker (`npm run
 * worker`), the Next server, and whatever relays session events into
 * /api/telemetry/ingest. Postgres is the only thing all three can reach, so
 * Postgres is the bus, and this route polls one index.
 *
 * Frames: an opening `batch` carrying the last hundred events for context,
 * then a `batch` per poll that found something. Nothing is sent when nothing
 * happened — an idle graph is the truth about an idle machine.
 */
export const GET = route(async (req: Request) => {
  await requireUserId();

  const encoder = new TextEncoder();
  let cursor: TailCursor = { ts: new Date().toISOString(), ids: [] };
  let closed = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    closed = true;
    if (poll) clearInterval(poll);
    if (beat) clearInterval(beat);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The consumer went away between the abort event and this write.
          stop();
        }
      };

      // Opening context. A page opened mid-session should show what just
      // happened, not an empty canvas that fills in over the next minute.
      const backfill = await readTailBackfill(db).catch(() => []);
      cursor = cursorFrom(backfill);
      send(sseFrame({ events: backfill, backfill: true }, "batch"));

      // One poll at a time: a slow query must not stack up behind the timer.
      let polling = false;
      // `tail` frames are sent only when this flips, so the client is told once
      // that the tail stopped delivering and once when it resumes. A stalled
      // graph must never be mistakeable for a quiet machine.
      let degraded = false;
      poll = setInterval(() => {
        if (closed || polling) return;
        polling = true;
        void readSince(db, new Date(cursor.ts))
          .then((rows) => {
            const next = advanceTail(cursor, rows);
            cursor = next.cursor;
            if (next.fresh.length > 0) send(sseFrame({ events: next.fresh }, "batch"));
            if (degraded) {
              degraded = false;
              send(sseFrame({ ok: true }, "tail"));
            }
          })
          .catch((err: unknown) => {
            if (degraded) return;
            degraded = true;
            send(
              sseFrame(
                { ok: false, message: err instanceof Error ? err.message : "poll failed" },
                "tail",
              ),
            );
          })
          .finally(() => {
            polling = false;
          });
      }, POLL_MS);

      beat = setInterval(() => send(SSE_HEARTBEAT), HEARTBEAT_MS);

      // Closing the tab is the normal way this ends.
      if (req.signal.aborted) stop();
      else req.signal.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // `no-transform` and the nginx hint stop an intermediary from buffering
      // frames into uselessly large chunks.
      "cache-control": "no-cache, no-store, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
});
