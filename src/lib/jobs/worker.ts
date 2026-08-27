import { type BackoffConfig, nextRunAfter } from "./backoff.ts";
import type { JobContext, JobHandlerMap, JobRecord, JobStore } from "./types.ts";

export interface WorkerConfig<Deps> {
  store: JobStore;
  /** Passed to every handler via `ctx.deps`. */
  deps: Deps;
  handlers: JobHandlerMap<Deps>;
  /** Max jobs in flight at once (WORKER_CONCURRENCY). */
  concurrency?: number;
  /** Idle poll interval when there is nothing to do. */
  pollIntervalMs?: number;
  backoff?: BackoffConfig;
  /** Clock seam for tests. */
  now?: () => number;
  onError?: (job: JobRecord, err: unknown) => void;
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
 */
export class JobWorker<Deps> {
  private readonly cfg: Required<Omit<WorkerConfig<Deps>, "backoff" | "onError">> &
    Pick<WorkerConfig<Deps>, "backoff" | "onError">;
  private controller = new AbortController();
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(config: WorkerConfig<Deps>) {
    this.cfg = {
      store: config.store,
      deps: config.deps,
      handlers: config.handlers,
      concurrency: config.concurrency ?? 2,
      pollIntervalMs: config.pollIntervalMs ?? 1_000,
      now: config.now ?? Date.now,
      backoff: config.backoff,
      onError: config.onError,
    };
  }

  /** Claim and process one batch (up to `concurrency`). Returns jobs handled. */
  async runOnce(): Promise<number> {
    const { store, concurrency, now } = this.cfg;
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

  private async process(job: JobRecord): Promise<void> {
    const { store, handlers, deps, backoff, onError } = this.cfg;
    const handler = handlers[job.kind];

    if (!handler) {
      await store.fail(job.id, `no handler registered for job kind ${job.kind}`);
      return;
    }

    const ctx: JobContext<Deps> = {
      job,
      deps,
      signal: this.controller.signal,
      setProgress: (fraction) =>
        store.setProgress(job.id, Math.max(0, Math.min(1, fraction))),
    };

    try {
      const result = await handler(ctx);
      await store.complete(job.id, result ?? {});
    } catch (err) {
      if (this.controller.signal.aborted) {
        // Shutting down — hand the job straight back, no attempt spent.
        await store.retry(job.id, new Date(this.cfg.now()));
        return;
      }
      onError?.(job, err);
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts >= job.maxAttempts) {
        await store.fail(job.id, message);
      } else {
        await store.retry(job.id, nextRunAfter(job.attempts, backoff));
      }
    }
  }

  /** Run until `stop()`. Resolves once the loop has exited. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
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
