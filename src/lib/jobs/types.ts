/**
 * Job worker runtime.
 *
 * The `Job` table (see prisma/schema.prisma) is the single queue: every
 * long-running operation is a row, and the API never blocks on ffmpeg. This
 * module is the generic execution engine — claim, dispatch, retry, back off.
 * The per-kind handlers (PROBE, TRANSCRIBE, …) are registered by the pipeline
 * PR that follows.
 *
 * String-literal unions mirror the Prisma enums exactly (Prisma serialises its
 * enums to these same strings), so this file has no `@prisma/client` import and
 * stays loadable by the strip-only test runner.
 */

export type JobStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type JobKind =
  | "FETCH"
  | "PROBE"
  | "EXTRACT_AUDIO"
  | "TRANSCRIBE"
  | "ANALYZE"
  | "RENDER"
  | "THUMBNAIL"
  | "LIVE_TRANSCRIBE"
  | "LIVE_FINALIZE"
  | "TRANSLATE";

export interface JobRecord {
  id: string;
  videoId: string;
  kind: JobKind;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  progress: number;
  payload: unknown;
  runAfter: Date;
}

/**
 * The slice of persistence the worker needs. A Prisma-backed implementation is
 * in `prisma-store.ts`; tests supply an in-memory one.
 */
export interface JobStore {
  /** QUEUED jobs whose `runAfter` has passed, oldest first, at most `limit`. */
  claimable(now: Date, limit: number): Promise<JobRecord[]>;
  /**
   * Compare-and-swap the row to PROCESSING and bump `attempts`. Returns the
   * updated record, or null if another worker got there first.
   */
  claim(id: string): Promise<JobRecord | null>;
  complete(id: string, result: unknown): Promise<void>;
  fail(id: string, errorMessage: string): Promise<void>;
  /** Return the job to QUEUED with a future `runAfter`. */
  retry(id: string, runAfter: Date): Promise<void>;
  setProgress(id: string, fraction: number): Promise<void>;
  /** Touch the row so a live job keeps its lease (see `reclaimStale`). */
  heartbeat(id: string): Promise<void>;
  /**
   * True when the row is CANCELLED (or gone) — the worker polls this for a live
   * job and aborts its handler so an in-flight download / transcription stops.
   */
  isCancelled(id: string): Promise<boolean>;
  /**
   * Requeue jobs stuck in PROCESSING since before `staleBefore` — a worker that
   * claimed them died without finishing. Returns how many were reclaimed.
   */
  reclaimStale(staleBefore: Date): Promise<number>;
}

export interface JobContext<Deps> {
  readonly job: JobRecord;
  readonly deps: Deps;
  /** Aborted when the worker is stopping; handlers should bail promptly. */
  readonly signal: AbortSignal;
  /** Persist a 0..1 progress fraction. */
  setProgress(fraction: number): Promise<void>;
}

/** Returns a JSON-serialisable result (stored on `Job.result`), or nothing. */
export type JobHandler<Deps> = (ctx: JobContext<Deps>) => Promise<unknown> | Promise<void>;

export type JobHandlerMap<Deps> = Partial<Record<JobKind, JobHandler<Deps>>>;
