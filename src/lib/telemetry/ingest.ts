/**
 * Validation and authorisation for relayed telemetry.
 *
 * /api/telemetry/ingest is the one door in this feature that something outside
 * the app knocks on: the orchestrator driving a Claude session relays what its
 * agents are doing so the graph can show them next to the app's own actors.
 * That makes it the one place where "the page only ever shows measured
 * activity" could be subverted, so the door is deliberately narrow — loopback
 * only, shared-secret only, whitelisted fields only.
 *
 * Both halves are pure functions taking plain values rather than a `Request`,
 * so the rules are tested directly instead of through HTTP.
 */

import { z } from "zod";

import { TELEMETRY_EVENT_TYPES, TELEMETRY_SOURCES, type TelemetryEventInput } from "./types.ts";

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const eventSchema = z.object({
  source: z.enum(TELEMETRY_SOURCES),
  eventType: z.enum(TELEMETRY_EVENT_TYPES),
  actor: z.string().min(1).max(120),
  targetActor: z.string().min(1).max(120).optional(),
  taskId: z.string().min(1).max(120).optional(),
  // Length is capped again by `sanitizeSummary`; this bound just stops a
  // megabyte of prose from being parsed before it is thrown away.
  summary: z.string().max(2000).default(""),
  status: z.string().max(32).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  estimatedTokensAvoided: z.number().int().min(0).optional(),
  latencyMs: z.number().int().min(0).optional(),
  model: z.string().max(120).optional(),
  meta: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  ts: z.string().datetime().optional(),
});

/** One request may relay a batch, but not an unbounded one. */
export const INGEST_MAX_EVENTS = 100;

const bodySchema = z.union([eventSchema, z.array(eventSchema).min(1).max(INGEST_MAX_EVENTS)]);

/**
 * Parse a request body into events. Accepts a single object or an array.
 * Throws `ZodError`, which the shared route wrapper renders as a 400 listing
 * the offending paths — a relay that is sending the wrong shape should be told
 * exactly what is wrong, not silently ignored.
 */
export function parseIngestBody(body: unknown): TelemetryEventInput[] {
  const parsed = bodySchema.parse(body);
  return (Array.isArray(parsed) ? parsed : [parsed]) as TelemetryEventInput[];
}

/* -------------------------------------------------------------------------- */
/* Authorisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Is this request from the machine the app is running on?
 *
 * Host-header based, matching how the rest of the desktop build reasons about
 * "local": the server binds loopback anyway, and a request that arrived with a
 * non-loopback Host was addressed to something else.
 */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL strips the brackets from an IPv6 literal.
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Compare in time independent of where the mismatch is.
 *
 * A plain `===` on a shared secret leaks its prefix to anything that can time
 * the response. `crypto.timingSafeEqual` would do the same job; this stays a
 * plain function so the module has no Node built-in import and loads in any
 * runtime the tests use.
 */
function secretsMatch(provided: string, expected: string): boolean {
  if (expected.length === 0) return false;
  let diff = provided.length ^ expected.length;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i % expected.length);
  }
  return diff === 0;
}

export type IngestAuth =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 501; error: string };

export interface IngestAuthInput {
  /** The full request URL, used for the loopback check. */
  url: string;
  /** Value of the `x-telemetry-key` header, or null when absent. */
  providedKey: string | null;
  /**
   * Contents of the file named by TELEMETRY_KEY_FILE, trimmed — or null when
   * the env var is unset or the file could not be read.
   */
  expectedKey: string | null;
}

/**
 * Decide whether an ingest request may proceed.
 *
 * Order matters. Loopback is checked first so a remote caller learns nothing
 * about whether ingest is configured on this machine; only something already
 * on the box gets told that the key file is missing.
 */
export function authorizeIngest(input: IngestAuthInput): IngestAuth {
  if (!isLoopbackUrl(input.url)) {
    return { ok: false, status: 403, error: "telemetry ingest accepts loopback requests only" };
  }
  if (!input.expectedKey) {
    return {
      ok: false,
      status: 501,
      error:
        "telemetry ingest is not configured — point TELEMETRY_KEY_FILE at a file containing a shared secret",
    };
  }
  if (!input.providedKey || !secretsMatch(input.providedKey, input.expectedKey)) {
    return { ok: false, status: 401, error: "x-telemetry-key missing or wrong" };
  }
  return { ok: true };
}
