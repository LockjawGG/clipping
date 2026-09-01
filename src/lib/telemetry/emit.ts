/**
 * Writing telemetry, and the two pure helpers everything else reuses.
 *
 * The contract for callers is that instrumentation is invisible: `emitTelemetry`
 * never throws, never rejects, and never changes the timing of the thing it is
 * measuring in a way that matters. A dashboard that can break a transcription
 * job is worse than no dashboard, so every failure path here ends in a log line.
 *
 * Nothing in this file invents a value. Fields the caller did not measure are
 * left out of the INSERT entirely, so a null in the database means "never
 * measured" rather than "measured as zero" — the UI shows those as
 * "not instrumented" instead of a confident 0.
 */

import {
  META_JSON_MAX,
  SUMMARY_MAX,
  TELEMETRY_EVENT_TYPES,
  TELEMETRY_SOURCES,
  type TelemetryDb,
  type TelemetryEventInput,
} from "./types.ts";

/* -------------------------------------------------------------------------- */
/* sanitizeSummary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ordered redactions. Order is load-bearing: the specific vendor shapes and the
 * `key=value` forms run before the generic "long opaque run" rule, so a
 * credential is reported as a credential rather than as an anonymous blob.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Home directories name a person, which is the whole reason to strip them.
  // Windows first (drive letter + backslashes), then the POSIX shapes.
  [/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+(?:[\\/][^\s"']*)?/gi, "<path>"],
  [/(?:^|(?<=[\s"'(=]))\/(?:home|Users)\/[^/\s"']+(?:\/[^\s"']*)?/g, "<path>"],
  // Authorization headers before the generic key=value rule. The optional
  // scheme word is part of the match so the header name does not survive with
  // the secret trimmed off it, which reads as though nothing was redacted.
  [/\b(?:authorization|bearer)\b\s*[:=]?\s*(?:bearer\s+)?\S{8,}/gi, "<redacted>"],
  // Vendor-shaped credentials. Longest prefixes first.
  [/\b(?:sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|AKIA|ASIA)[A-Za-z0-9_-]{8,}/g, "<redacted>"],
  // Anything a human labelled as a secret, however it is spelled.
  [/\b[\w-]*(?:api[_-]?key|key|token|secret|password|passwd|pwd)[\w-]*\s*[:=]\s*"?[^\s"',]{4,}"?/gi, "<redacted>"],
  // Long opaque runs — JWTs, hashes, base64. Required to mix letters and
  // digits so ordinary hyphenated prose ("clip-suggestions-for-a-video")
  // is not mistaken for a credential.
  [/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{28,}={0,2}/g, "<redacted>"],
];

/**
 * Make a summary safe to store and show: strip credential- and path-shaped
 * text, flatten whitespace, cap at `SUMMARY_MAX`.
 *
 * This is defence in depth, not a licence to pass secrets in. Callers are
 * expected to write their own short human sentence ("assistant chat turn");
 * the redactions exist because a summary that ever interpolates an error
 * message can pick up a token or a home directory by accident, and this page
 * is designed to be left open on a second monitor.
 */
export function sanitizeSummary(input: unknown, max: number = SUMMARY_MAX): string {
  if (typeof input !== "string" || input.length === 0) return "";
  let out = input;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  // Control characters would break the SSE framing further down the line.
  out = out.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (out.length <= max) return out;
  return `${out.slice(0, Math.max(0, max - 1))}…`;
}

/* -------------------------------------------------------------------------- */
/* estimateTokensAvoided                                                      */
/* -------------------------------------------------------------------------- */

export interface TokensAvoidedInput {
  /** Tokens the delegate actually consumed as input. */
  workerInput?: number;
  /** Tokens the delegate actually produced. */
  workerOutput?: number;
  /**
   * What the top tier still had to spend to delegate: the brief it wrote plus
   * the result it read back. Zero for a local model, where the top tier was
   * never in the loop at all.
   */
  orchestratorOverhead?: number;
}

/**
 * ESTIMATED top-tier tokens avoided by delegation.
 *
 *     estimated = max(0, workerInput + workerOutput - orchestratorOverhead)
 *
 * The reasoning: work done by a delegate is work the top-tier model did not
 * have to do itself, minus what the top tier still spent briefing the delegate
 * and reading its answer. It is an ESTIMATE and is labelled as one everywhere
 * it is shown, because the counterfactual — how many tokens the top tier would
 * have burned doing the same job — cannot be measured, only bounded. It is
 * deliberately conservative: overhead is subtracted in full, and the result is
 * floored at zero so a delegation that cost more than it saved reads as zero
 * saved rather than as a negative that quietly inflates some other total.
 *
 * Inputs that were never measured count as 0, which keeps the estimate low
 * rather than optimistic.
 */
export function estimateTokensAvoided(input: TokensAvoidedInput): number {
  const n = (v: number | undefined): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  return Math.max(0, n(input.workerInput) + n(input.workerOutput) - n(input.orchestratorOverhead));
}

/* -------------------------------------------------------------------------- */
/* Row building                                                               */
/* -------------------------------------------------------------------------- */

/** Postgres `Int` is 32-bit; a count past this is a bug upstream, not a value. */
const INT_MAX = 2_147_483_647;

/** Round, floor at 0, clamp to Int — or `undefined` when there is nothing to store. */
function counter(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(INT_MAX, Math.round(value));
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

const EVENT_TYPES = new Set<string>(TELEMETRY_EVENT_TYPES);
const SOURCES = new Set<string>(TELEMETRY_SOURCES);

/**
 * Whitelist an input down to exactly the columns that exist, or return null
 * when the event is unusable.
 *
 * Pure and exported so the ingest route and its tests share one definition of
 * "a well-formed event" with the in-process emitter — the two must not drift,
 * or a relayed event and a local one would render differently.
 */
export function buildTelemetryRow(event: TelemetryEventInput): Record<string, unknown> | null {
  const source = text(event.source, 32);
  const eventType = text(event.eventType, 64);
  const actor = text(event.actor, 120);
  if (!source || !SOURCES.has(source)) return null;
  if (!eventType || !EVENT_TYPES.has(eventType)) return null;
  if (!actor) return null;

  const row: Record<string, unknown> = {
    source,
    eventType,
    actor,
    summary: sanitizeSummary(event.summary),
  };

  const targetActor = text(event.targetActor, 120);
  if (targetActor) row.targetActor = targetActor;
  const taskId = text(event.taskId, 120);
  if (taskId) row.taskId = taskId;
  const status = text(event.status, 32);
  if (status) row.status = status;
  const model = text(event.model, 120);
  if (model) row.model = model;

  const inputTokens = counter(event.inputTokens);
  if (inputTokens !== undefined) row.inputTokens = inputTokens;
  const outputTokens = counter(event.outputTokens);
  if (outputTokens !== undefined) row.outputTokens = outputTokens;
  const avoided = counter(event.estimatedTokensAvoided);
  if (avoided !== undefined) row.estimatedTokensAvoided = avoided;
  const latencyMs = counter(event.latencyMs);
  if (latencyMs !== undefined) row.latencyMs = latencyMs;

  // A relayed event may carry the moment it actually happened; a local one
  // lets the database stamp it. An unparseable date is dropped, not guessed.
  if (typeof event.ts === "string") {
    const when = new Date(event.ts);
    if (!Number.isNaN(when.getTime())) row.ts = when;
  }

  if (event.meta && typeof event.meta === "object") {
    const encoded = JSON.stringify(event.meta);
    // Over the cap it is dropped rather than truncated: half a JSON document
    // is not parseable, and this column exists to stay small.
    if (encoded.length <= META_JSON_MAX) row.metaJson = encoded;
  }

  return row;
}

/* -------------------------------------------------------------------------- */
/* emitTelemetry                                                              */
/* -------------------------------------------------------------------------- */

/** Failures are logged at most this often. A database that is down would
 *  otherwise print once per job poll and bury everything else in the log. */
const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;

function warnOnce(err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn(`[telemetry] event dropped: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Record one event. Fire-and-forget: the returned promise always resolves, so
 * a caller may `await` it for ordering or ignore it entirely, and neither
 * choice can fail the work being measured.
 *
 * Resolves to whether the row was actually written. Most callers ignore that —
 * but the ingest route reports it back to its relay, because telling a caller
 * "accepted" for a row that was silently dropped is exactly the kind of
 * comfortable fiction this feature exists to avoid.
 */
export async function emitTelemetry(db: TelemetryDb, event: TelemetryEventInput): Promise<boolean> {
  try {
    const data = buildTelemetryRow(event);
    if (!data) return false;
    await db.telemetryEvent.create({ data });
    return true;
  } catch (err) {
    warnOnce(err);
    return false;
  }
}

/** Test seam: forget that we recently warned, so warning behaviour is testable. */
export function resetTelemetryWarnState(): void {
  lastWarnAt = 0;
}
