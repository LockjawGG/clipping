/**
 * The telemetry wire contract, shared by the emitter, the ingest route, the
 * SSE stream and the browser.
 *
 * Deliberately free of `@prisma/client` and of any Node built-in: the /brain
 * client components import these types, and the strip-only test runner loads
 * this file directly. The persistence shape lives in `TelemetryEvent` in
 * prisma/schema.prisma and must stay in step with `TelemetryEventRow` below.
 *
 * The one rule the whole feature is built on: every field here is *measured*.
 * Nothing in this pipeline invents a number, and a field that was never
 * measured stays absent rather than defaulting to zero — the UI needs to be
 * able to tell "0 tokens" from "we never counted".
 */

/**
 * Where the row came from.
 * - "clipper" — emitted in-process by the app or the ingest worker.
 * - "session" — relayed in over /api/telemetry/ingest by whatever is driving
 *   the Claude session; the app itself never fabricates these.
 */
export const TELEMETRY_SOURCES = ["clipper", "session"] as const;
export type TelemetrySource = (typeof TELEMETRY_SOURCES)[number];

/**
 * Closed set on purpose. The graph decides what to draw from `eventType`, so an
 * unrecognised one is a silent hole in the picture; ingest rejects it instead.
 */
export const TELEMETRY_EVENT_TYPES = [
  /** A model call finished. Carries real token counts when the API reports them. */
  "llm.request.completed",
  /** A unit of work started / ended. `actor` is who ran it. */
  "task.started",
  "task.completed",
  "task.failed",
  /** Work handed from `actor` to `targetActor`, and the result coming back. */
  "delegation.started",
  "delegation.completed",
  /** An actor came into / went out of existence (session agents spawning). */
  "actor.online",
  "actor.offline",
] as const;
export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

/** Longest a summary may be once stored; enforced by `sanitizeSummary`. */
export const SUMMARY_MAX = 200;

/** Longest `metaJson` may be; anything bigger is dropped, not truncated
 *  (half a JSON document is worse than none). */
export const META_JSON_MAX = 512;

/** What a producer hands to `emitTelemetry`. Everything optional is optional
 *  because it may genuinely not have been measured. */
export interface TelemetryEventInput {
  source: TelemetrySource;
  eventType: TelemetryEventType;
  /** Who acted: "ollama:llama3.2", "job:TRANSCRIBE", "opus", "sonnet", … */
  actor: string;
  /** Who the work was handed to, for delegation edges. */
  targetActor?: string;
  /** Correlates start/finish pairs — a job id, a session task id. */
  taskId?: string;
  summary: string;
  status?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** See `estimateTokensAvoided` — an estimate, and labelled as one everywhere. */
  estimatedTokensAvoided?: number;
  latencyMs?: number;
  model?: string;
  /** Small flat bag of extras. Serialised to `metaJson`; dropped when large. */
  meta?: Record<string, string | number | boolean>;
  /** Origin timestamp for relayed events. Absent = "now", set by the database. */
  ts?: string;
}

/** A stored row, as the API hands it to the browser. `ts` is an ISO string
 *  because it crosses JSON; nulls mean "not measured". */
export interface TelemetryEventRow {
  id: string;
  ts: string;
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
}

/**
 * The slice of Prisma the emitter needs, declared structurally so this module
 * (and its tests) never import the generated client — the same narrowing
 * `LiveSweepDb` uses in the pipeline.
 */
export interface TelemetryDb {
  telemetryEvent: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}
