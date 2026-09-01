import { type BackoffConfig, nextRunAfter } from "./backoff.ts";
import type { JobContext, JobHandlerMap, JobRecord, JobStore } from "./types.ts";

/**
 * What the worker saw happen to one job, announced for anything that wants to
 * record it.
 *
 * A plain value with no persistence in it on purpose: this engine has no
 * `@prisma/client` import (see the note in types.ts) and must stay loadable by
 * the strip-only test runner, so *writing* telemetry lives at the wiring site
 * in pipeline/worker-entry.ts and this file only announces.
 */
export interface JobLifecycleEvent {
  phase: "started" | "completed" | "failed";
  job: JobRecord;
  /** How long the handler ran, measured here. Absent on "started". */
  latencyMs?: number;
  /** "running" | "ok" | "failed" | "retrying" | "cancelled". */
  status: string;
  /** Failure detail, when there is one. */
  message?: string;
}

export interface WorkerConfig<Deps> {
  store: JobStore;
  /** Passed to every handler via `ctx.deps`. */
  deps: Deps;
  handlers: JobHandlerMap<Deps>;
  /** Max jobs in flight at once (WORKER_CONCURRENCY). */
  concurrency?: number;
  /** Idle poll interval when there is nothing to do. */
  pollIntervalMs?: number;
  /** A PROCESSING job untouched for this long is considered abandoned. */
  leaseMs?: number;
  /** How often an in-flight job touches its row to keep the lease. */
  heartbeatMs?: number;
  /** Called after a job finishes (success or failure) — e.g. to wipe scratch. */
  cleanup?: (job: JobRecord) => Promise<void>;
  backoff?: BackoffConfig;
  /** Clock seam for tests. */
  now?: () => number;
  onError?: (job: JobRecord, err: unknown) => void;
  /**
   * Called once a job is permanently FAILED (attempts exhausted) — not on the
   * intermediate retries. Used to move the job's video into a terminal state so
   * it stops showing as "processing" forever.
   */
  onJobFailed?: (job: JobRecord, message: string) => void | Promise<void>;
  /**
   * Called as a job starts and again as it ends. Purely observational: it is
   * invoked synchronously, its return value is ignored, and anything it throws
   * is routed to `onError` rather than failing the job being watched.
   *
   * Nothing is announced when a job is handed back during shutdown: it neither
   * finished nor failed, and a consumer that sees only "started" is telling the
   * truth about what was observed.
   */
  onJobEvent?: (event: JobLifecycleEvent) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Polls the job queue and runs the registered handler for each job's `kind`.
 *
 * - A job is claimed with a compare-and-swap, so two workers never run the same
 *   row even without row locks.
 * - Handler throws → back to QUEUED with an exponential-backoff `runAfter`,
 *   until `attempts` reaches `maxAttempts`, then FAILED.
 * - `stop()` aborts in-flight handlers and returns the current job to the queue
 *   without spending an attempt.
 * - A running job heartbeats its row; a job stuck in PROCESSING past its lease
 *   (its worker crashed) is requeued by `reclaimStale`.
 */
export class JobWorker<Deps> {
  private readonly cfg: Required<
    Omit<WorkerConfig<Deps>, "backoff" | "onError" | "cleanup" | "onJobFailed" | "onJobEvent">
  > &
    Pick<WorkerConfig<Deps>, "backoff" | "onError" | "cleanup" | "onJobFailed" | "onJobEvent">;
  private controller = new AbortController();
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private lastReclaim = 0;

  constructor(config: WorkerConfig<Deps>) {
    this.cfg = {
      store: config.store,
      deps: config.deps,
      handlers: config.handlers,
      concurrency: config.concurrency ?? 2,
      pollIntervalMs: config.pollIntervalMs ?? 1_000,
      leaseMs: config.leaseMs ?? 120_000,
      heartbeatMs: config.heartbeatMs ?? 30_000,
      now: config.now ?? Date.now,
      backoff: config.backoff,
      onError: config.onError,
      cleanup: config.cleanup,
      onJobFailed: config.onJobFailed,
      onJobEvent: config.onJobEvent,
    };
  }

  /** Requeue jobs whose worker died mid-flight. */
  async reclaimStale(): Promise<number> {
    this.lastReclaim = this.cfg.now();
    const staleBefore = new Date(this.cfg.now() - this.cfg.leaseMs);
    const n = await this.cfg.store.reclaimStale(staleBefore);
    if (n > 0) this.cfg.onError?.({ id: "-", kind: "PROBE" } as JobRecord, `reclaimed ${n} stale job(s)`);
    return n;
  }

  /** Claim and process one batch (up to `concurrency`). Returns jobs handled. */
  async runOnce(): Promise<number> {
    const { store, concurrency, now } = this.cfg;

    if (now() - this.lastReclaim >= this.cfg.leaseMs) {
      await this.reclaimStale();
    }

    const pending = await store.claimable(new Date(now()), concurrency);
    if (pending.length === 0) return 0;

    const claimed: JobRecord[] = [];
    for (const job of pending) {
      const c = await store.claim(job.id);
      if (c) claimed.push(c);
    }

    await Promise.all(claimed.map((job) => this.process(job)));
    return claimed.length;
  }

  /** Tell the observer, and never let it break the job it is observing. */
  private announce(event: JobLifecycleEvent): void {
    try {
      this.cfg.onJobEvent?.(event);
    } catch (err) {
      this.cfg.onError?.(event.job, err);
    }
  }

  private async process(job: JobRecord): Promise<void> {
    const { store, handlers, deps, backoff, onError, cleanup } = this.cfg;
    const handler = handlers[job.kind];

    if (!handler) {
      const message = `no handler registered for job kind ${job.kind}`;
      await store.fail(job.id, message);
      this.announce({ phase: "failed", job, status: "failed", message });
      await cleanup?.(job).catch(() => {});
      return;
    }

    // Per-job abort: fires on worker shutdown OR when the user cancels this job.
    const jobAbort = new AbortController();
    const onShutdown = () => jobAbort.abort();
    this.controller.signal.addEventListener("abort", onShutdown);
    let cancelled = false;

    // Keep the lease alive through long, silent steps (a 1GB download), and
    // poll for a user cancellation so the handler (and its yt-dlp / ffmpeg
    // subprocess, which gets the signal) is stopped promptly.
    const beat = setInterval(() => {
      void store.heartbeat(job.id).catch(() => {});
      void store
        .isCancelled(job.id)
        .then((c) => {
          if (c) {
            cancelled = true;
            jobAbort.abort();
          }
        })
        .catch(() => {});
    }, this.cfg.heartbeatMs);
    (beat as unknown as { unref?: () => void }).unref?.();

    const ctx: JobContext<Deps> = {
      job,
      deps,
      signal: jobAbort.signal,
      setProgress: (fraction) => store.setProgress(job.id, Math.max(0, Math.min(1, fraction))),
    };

    // Handler wall-clock, from this worker's own clock seam, so a test can
    // drive it deterministically and the reported latency is the real one.
    const startedAt = this.cfg.now();
    const ranFor = () => this.cfg.now() - startedAt;
    this.announce({ phase: "started", job, status: "running" });

    try {
      const result = await handler(ctx);
      if (cancelled) {
        // User cancelled — leave the row CANCELLED. Reported as an ending, not
        // a success: the work did not produce what it was asked for.
        this.announce({ phase: "failed", job, status: "cancelled", latencyMs: ranFor() });
        return;
      }
      await store.complete(job.id, result ?? {});
      this.announce({ phase: "completed", job, status: "ok", latencyMs: ranFor() });
    } catch (err) {
      if (cancelled) {
        // cancelled: swallow the abort error, keep it CANCELLED
        this.announce({ phase: "failed", job, status: "cancelled", latencyMs: ranFor() });
        return;
      }
      if (this.controller.signal.aborted) {
        // Shutting down — hand the job straight back, no attempt spent, and
        // announce nothing: it neither finished nor failed.
        await store.retry(job.id, new Date(this.cfg.now()));
        return;
      }
      onError?.(job, err);
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts >= job.maxAttempts) {
        await store.fail(job.id, message);
        await this.cfg.onJobFailed?.(job, message);
        this.announce({ phase: "failed", job, status: "failed", message, latencyMs: ranFor() });
      } else {
        await store.retry(job.id, nextRunAfter(job.attempts, backoff));
        // Distinct status: an attempt that will be tried again is not the same
        // news as a job that is out of retries.
        this.announce({ phase: "failed", job, status: "retrying", message, latencyMs: ranFor() });
      }
    } finally {
      clearInterval(beat);
      this.controller.signal.removeEventListener("abort", onShutdown);
      await cleanup?.(job).catch(() => {});
    }
  }

  /** Run until `stop()`. Resolves once the loop has exited. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    this.lastReclaim = 0; // force a reclaim on the first tick
    this.loopDone = this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running && !this.controller.signal.aborted) {
      let handled = 0;
      try {
        handled = await this.runOnce();
      } catch (err) {
        this.cfg.onError?.({ id: "-", kind: "PROBE" } as JobRecord, err);
      }
      if (!this.running) break;
      if (handled === 0) await sleep(this.cfg.pollIntervalMs, this.controller.signal);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller.abort();
    await this.loopDone;
  }
}
