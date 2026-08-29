import { LIVE_HEARTBEAT_TIMEOUT_MS } from "../api/live.ts";
import type { JobKind } from "../jobs/types.ts";

/**
 * Recovery for live sessions whose browser never came back.
 *
 * A recording is finalised when the tab calls Stop. If the tab crashes, the
 * machine sleeps, or the user just closes it, Stop never arrives and the video
 * sits in LIVE forever with its fragments stranded in storage — recoverable in
 * principle, unreachable in practice.
 *
 * The client checks in every 15s. Once a session's heartbeat is older than
 * `LIVE_HEARTBEAT_TIMEOUT_MS`, this claims it and runs the same finalisation
 * Stop would have: whatever fragments landed become the recording.
 */

export interface LiveSweepDb {
  video: {
    findMany(a: {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    }): Promise<Array<{ id: string; _count: { liveChunks: number } }>>;
    updateMany(a: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

export interface LiveSweepOptions {
  db: LiveSweepDb;
  enqueue: (input: { videoId: string; kind: JobKind }) => Promise<string>;
  timeoutMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface LiveSweepResult {
  /** Sessions handed to LIVE_FINALIZE. */
  recovered: string[];
  /** Sessions abandoned before a single fragment landed. */
  discarded: string[];
}

/** One pass. Safe to run concurrently — each claim is a compare-and-swap. */
export async function sweepLiveSessions(opts: LiveSweepOptions): Promise<LiveSweepResult> {
  const now = opts.now?.() ?? Date.now();
  const deadline = new Date(now - (opts.timeoutMs ?? LIVE_HEARTBEAT_TIMEOUT_MS));
  const recovered: string[] = [];
  const discarded: string[] = [];

  const stale = await opts.db.video.findMany({
    where: {
      status: "LIVE",
      OR: [
        { liveHeartbeatAt: { lt: deadline } },
        // Pre-heartbeat rows, and sessions that died before their first check-in.
        { liveHeartbeatAt: null, createdAt: { lt: deadline } },
      ],
    },
    select: { id: true, _count: { select: { liveChunks: true } } },
  });

  for (const v of stale) {
    const hasFragments = v._count.liveChunks > 0;
    // CAS on status: whoever flips it out of LIVE owns the session, so a second
    // worker (or a Stop that arrives late) can't enqueue finalisation twice.
    const { count } = await opts.db.video.updateMany({
      where: { id: v.id, status: "LIVE" },
      data: hasFragments
        ? { status: "PROBING", liveHeartbeatAt: null }
        : {
            status: "FAILED",
            liveHeartbeatAt: null,
            errorMessage: "Recording stopped unexpectedly before any audio was saved.",
          },
    });
    if (count === 0) continue; // someone else claimed it

    if (hasFragments) {
      await opts.enqueue({ videoId: v.id, kind: "LIVE_FINALIZE" });
      recovered.push(v.id);
    } else {
      discarded.push(v.id);
    }
  }

  if (recovered.length || discarded.length) {
    opts.log?.(
      `live sweep: recovered ${recovered.length}, discarded ${discarded.length} abandoned session(s)`,
    );
  }
  return { recovered, discarded };
}

/**
 * Run the sweep on an interval. Returns a stop function. Errors are logged,
 * never thrown — recovery must not take the worker down with it.
 */
export function startLiveSweep(opts: {
  db: LiveSweepDb;
  enqueue: (input: { videoId: string; kind: JobKind }) => Promise<string>;
  intervalMs?: number;
}): () => void {
  const run = () =>
    sweepLiveSessions({
      db: opts.db,
      enqueue: opts.enqueue,
      log: (m) => console.log(`[worker] ${m}`),
    }).catch((e) => console.error(`[worker] live sweep failed: ${e}`));

  void run();
  const timer = setInterval(run, opts.intervalMs ?? 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
