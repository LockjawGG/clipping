import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTelemetryRow,
  estimateTokensAvoided,
  sanitizeSummary,
} from "../src/lib/telemetry/emit.ts";
import {
  authorizeIngest,
  isLoopbackUrl,
  parseIngestBody,
} from "../src/lib/telemetry/ingest.ts";
import { advanceTail, cursorFrom, sseFrame } from "../src/lib/telemetry/stream.ts";
import { buildReplaySchedule, replayDurationMs } from "../src/lib/telemetry/replay.ts";
import {
  deriveActors,
  deriveEdges,
  deriveStats,
  pickOrchestrator,
  pulseIntensity,
  COMPLETED_FLASH_MS,
  WORKING_STALE_MS,
} from "../src/lib/telemetry/derive.ts";
import {
  HISTORY_MAX_ROWS,
  HISTORY_DEFAULT_WINDOW_MS,
  parseHistoryQuery,
} from "../src/lib/telemetry/read.ts";
import type { TelemetryEventRow } from "../src/lib/telemetry/types.ts";

/* ------------------------------------------------------------------------- */
/* sanitizeSummary — the page is left open on a second monitor                */
/* ------------------------------------------------------------------------- */

test("sanitizeSummary: home directories lose the username", () => {
  assert.equal(
    sanitizeSummary("failed reading C:\\Users\\jsmith\\Videos\\raw.mp4"),
    "failed reading <path>",
  );
  assert.equal(sanitizeSummary("ffmpeg wrote /home/jsmith/clips/out.mp4"), "ffmpeg wrote <path>");
  assert.equal(sanitizeSummary("opened /Users/jsmith/Desktop/a.mov"), "opened <path>");
});

test("sanitizeSummary: vendor-shaped credentials are removed", () => {
  assert.equal(
    sanitizeSummary("auth failed for sk-ant-api03-AbCdEfGh12345678"),
    "auth failed for <redacted>",
  );
  assert.equal(sanitizeSummary("token ghp_AbCdEfGh12345678zz"), "token <redacted>");
  assert.equal(sanitizeSummary("using AKIAIOSFODNN7EXAMPLE"), "using <redacted>");
});

test("sanitizeSummary: anything labelled as a secret is removed", () => {
  assert.equal(sanitizeSummary("api_key=hunter2000"), "<redacted>");
  assert.equal(sanitizeSummary("password: correcthorse"), "<redacted>");
  assert.equal(sanitizeSummary("Authorization: Bearer abcdefghijklmnop"), "<redacted>");
});

test("sanitizeSummary: long opaque blobs go, ordinary prose stays", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  assert.equal(sanitizeSummary(`sent ${jwt}`), "sent <redacted>");
  // A digit-free hyphenated phrase is prose, however long, and must survive.
  const prose = "clip-suggestions-for-a-very-long-conference-talk";
  assert.equal(sanitizeSummary(prose), prose);
  assert.equal(sanitizeSummary("TRANSCRIBE for video clx7k2p9"), "TRANSCRIBE for video clx7k2p9");
});

test("sanitizeSummary: whitespace and control characters collapse", () => {
  assert.equal(sanitizeSummary("  two\n\nlines\tand   spaces  "), "two lines and spaces");
  assert.equal(sanitizeSummary("frame\u0000break"), "frame break");
});

test("sanitizeSummary: capped, with a marker that it was cut", () => {
  const long = "a".repeat(500);
  const out = sanitizeSummary(long);
  assert.equal(out.length, 200);
  assert.ok(out.endsWith("…"));
  assert.equal(sanitizeSummary("abcdef", 4), "abc…");
});

test("sanitizeSummary: anything that is not a string is empty", () => {
  assert.equal(sanitizeSummary(undefined), "");
  assert.equal(sanitizeSummary(null), "");
  assert.equal(sanitizeSummary(42), "");
  assert.equal(sanitizeSummary(""), "");
});

/* ------------------------------------------------------------------------- */
/* estimateTokensAvoided — the documented formula                            */
/* ------------------------------------------------------------------------- */

test("estimateTokensAvoided: worker input + output − orchestrator overhead", () => {
  assert.equal(
    estimateTokensAvoided({ workerInput: 8000, workerOutput: 2000, orchestratorOverhead: 1500 }),
    8500,
  );
  // A local model costs the top tier nothing to brief.
  assert.equal(
    estimateTokensAvoided({ workerInput: 1200, workerOutput: 300, orchestratorOverhead: 0 }),
    1500,
  );
});

test("estimateTokensAvoided: floored at zero, never negative", () => {
  assert.equal(
    estimateTokensAvoided({ workerInput: 100, workerOutput: 50, orchestratorOverhead: 5000 }),
    0,
  );
});

test("estimateTokensAvoided: unmeasured inputs count as nothing, not as noise", () => {
  assert.equal(estimateTokensAvoided({}), 0);
  assert.equal(estimateTokensAvoided({ workerOutput: 700 }), 700);
  assert.equal(estimateTokensAvoided({ workerInput: 700, orchestratorOverhead: undefined }), 700);
  assert.equal(estimateTokensAvoided({ workerInput: Number.NaN, workerOutput: 10 }), 10);
  assert.equal(estimateTokensAvoided({ workerInput: -50, workerOutput: 10 }), 10);
  assert.equal(estimateTokensAvoided({ workerInput: 10.4, workerOutput: 0.6 }), 11);
});

/* ------------------------------------------------------------------------- */
/* buildTelemetryRow — the whitelist                                          */
/* ------------------------------------------------------------------------- */

const validInput = {
  source: "clipper",
  eventType: "task.started",
  actor: "job:TRANSCRIBE",
  summary: "TRANSCRIBE for video clx7k2p9",
} as const;

test("buildTelemetryRow: rejects anything outside the closed sets", () => {
  assert.equal(buildTelemetryRow({ ...validInput, source: "somewhere" as never }), null);
  assert.equal(buildTelemetryRow({ ...validInput, eventType: "made.up" as never }), null);
  assert.equal(buildTelemetryRow({ ...validInput, actor: "   " }), null);
});

test("buildTelemetryRow: unmeasured fields are absent, not zero", () => {
  const row = buildTelemetryRow({ ...validInput });
  assert.ok(row);
  assert.equal("inputTokens" in row, false);
  assert.equal("latencyMs" in row, false);
  assert.equal("targetActor" in row, false);
  assert.equal(row.summary, "TRANSCRIBE for video clx7k2p9");
});

test("buildTelemetryRow: unknown keys never reach the row", () => {
  const row = buildTelemetryRow({
    ...validInput,
    // A relay could send anything; only declared columns survive.
    videoPath: "C:/Users/jsmith/secret.mp4",
    isAdmin: true,
  } as never);
  assert.ok(row);
  assert.deepEqual(Object.keys(row).sort(), ["actor", "eventType", "source", "summary"]);
});

test("buildTelemetryRow: counters are clamped and rounded", () => {
  const row = buildTelemetryRow({
    ...validInput,
    inputTokens: 12.6,
    outputTokens: -4,
    latencyMs: 9e12,
  });
  assert.ok(row);
  assert.equal(row.inputTokens, 13);
  assert.equal("outputTokens" in row, false);
  assert.equal(row.latencyMs, 2_147_483_647);
});

test("buildTelemetryRow: oversized meta is dropped whole, never truncated", () => {
  const small = buildTelemetryRow({ ...validInput, meta: { attempt: 2 } });
  assert.equal(small?.metaJson, '{"attempt":2}');
  const big = buildTelemetryRow({ ...validInput, meta: { blob: "x".repeat(1000) } });
  assert.ok(big);
  assert.equal("metaJson" in big, false);
});

test("buildTelemetryRow: a relayed timestamp is honoured, a broken one ignored", () => {
  const good = buildTelemetryRow({ ...validInput, ts: "2026-08-31T10:00:00.000Z" });
  assert.ok(good?.ts instanceof Date);
  const bad = buildTelemetryRow({ ...validInput, ts: "yesterday-ish" });
  assert.ok(bad);
  assert.equal("ts" in bad, false);
});

/* ------------------------------------------------------------------------- */
/* Ingest: validation and authorisation                                       */
/* ------------------------------------------------------------------------- */

test("parseIngestBody: accepts one event or a batch", () => {
  assert.equal(parseIngestBody(validInput).length, 1);
  assert.equal(parseIngestBody([validInput, validInput]).length, 2);
});

test("parseIngestBody: rejects the wrong shape rather than guessing", () => {
  assert.throws(() => parseIngestBody({ source: "clipper" }));
  assert.throws(() => parseIngestBody({ ...validInput, eventType: "task.exploded" }));
  assert.throws(() => parseIngestBody({ ...validInput, inputTokens: -1 }));
  assert.throws(() => parseIngestBody([]));
  assert.throws(() => parseIngestBody(Array.from({ length: 101 }, () => validInput)));
});

test("parseIngestBody: summary defaults to empty rather than failing the batch", () => {
  const [event] = parseIngestBody({ ...validInput, summary: undefined });
  assert.equal(event.summary, "");
});

test("isLoopbackUrl: only this machine", () => {
  assert.equal(isLoopbackUrl("http://localhost:3000/api/telemetry/ingest"), true);
  assert.equal(isLoopbackUrl("http://127.0.0.1:3000/x"), true);
  assert.equal(isLoopbackUrl("http://127.5.5.5:3000/x"), true);
  assert.equal(isLoopbackUrl("http://[::1]:3000/x"), true);
  assert.equal(isLoopbackUrl("https://clipper.example.com/x"), false);
  assert.equal(isLoopbackUrl("http://192.168.1.4:3000/x"), false);
  assert.equal(isLoopbackUrl("not a url"), false);
});

test("authorizeIngest: a remote caller learns nothing about the configuration", () => {
  const remote = authorizeIngest({
    url: "https://clipper.example.com/api/telemetry/ingest",
    providedKey: "correct",
    expectedKey: "correct",
  });
  assert.deepEqual(remote.ok, false);
  assert.equal(remote.ok === false && remote.status, 403);
});

test("authorizeIngest: unconfigured is 501, wrong key is 401, right key passes", () => {
  const url = "http://localhost:3000/api/telemetry/ingest";
  const unset = authorizeIngest({ url, providedKey: "anything", expectedKey: null });
  assert.equal(unset.ok === false && unset.status, 501);
  assert.ok(unset.ok === false && unset.error.includes("TELEMETRY_KEY_FILE"));

  const missing = authorizeIngest({ url, providedKey: null, expectedKey: "s3cret" });
  assert.equal(missing.ok === false && missing.status, 401);
  // A prefix of the key is as wrong as anything else.
  const partial = authorizeIngest({ url, providedKey: "s3cre", expectedKey: "s3cret" });
  assert.equal(partial.ok === false && partial.status, 401);
  assert.deepEqual(authorizeIngest({ url, providedKey: "s3cret", expectedKey: "s3cret" }), {
    ok: true,
  });
});

/* ------------------------------------------------------------------------- */
/* Tail cursor — exactly-once across a shared millisecond                     */
/* ------------------------------------------------------------------------- */

function row(id: string, ts: string, over: Partial<TelemetryEventRow> = {}): TelemetryEventRow {
  return {
    id,
    ts,
    source: "clipper",
    eventType: "task.completed",
    actor: "job:PROBE",
    targetActor: null,
    taskId: null,
    summary: "",
    status: null,
    inputTokens: null,
    outputTokens: null,
    estimatedTokensAvoided: null,
    latencyMs: null,
    model: null,
    metaJson: null,
    ...over,
  };
}

test("advanceTail: the backfill is not resent, and its millisecond twin is not lost", () => {
  const a = row("a", "2026-08-31T10:00:00.000Z");
  const b = row("b", "2026-08-31T10:00:00.000Z");
  const cursor = cursorFrom([a]);
  assert.deepEqual(cursor, { ts: a.ts, ids: ["a"] });

  // The next poll is inclusive of the cursor's timestamp and sees both rows.
  const first = advanceTail(cursor, [a, b]);
  assert.deepEqual(
    first.fresh.map((r) => r.id),
    ["b"],
  );
  assert.deepEqual(first.cursor.ids.sort(), ["a", "b"]);

  // Polling again with the same rows yields nothing.
  assert.equal(advanceTail(first.cursor, [a, b]).fresh.length, 0);
});

test("advanceTail: ids are not carried past the millisecond they belong to", () => {
  const start = cursorFrom([row("a", "2026-08-31T10:00:00.000Z")]);
  const next = advanceTail(start, [row("b", "2026-08-31T10:00:01.000Z")]);
  assert.deepEqual(next.cursor, { ts: "2026-08-31T10:00:01.000Z", ids: ["b"] });
});

test("advanceTail: output is oldest-first whatever order it arrives in", () => {
  const cursor = { ts: "2026-08-31T09:00:00.000Z", ids: [] };
  const { fresh } = advanceTail(cursor, [
    row("c", "2026-08-31T10:00:02.000Z"),
    row("a", "2026-08-31T10:00:00.000Z"),
    row("b", "2026-08-31T10:00:01.000Z"),
  ]);
  assert.deepEqual(
    fresh.map((r) => r.id),
    ["a", "b", "c"],
  );
});

test("sseFrame: one line of data, terminated by a blank line", () => {
  assert.equal(sseFrame({ n: 1 }), 'data: {"n":1}\n\n');
  assert.equal(sseFrame({ n: 1 }, "batch"), 'event: batch\ndata: {"n":1}\n\n');
  // A newline inside a value must not become a frame boundary.
  assert.equal(sseFrame({ s: "a\nb" }).split("\n\n").length, 2);
});

/* ------------------------------------------------------------------------- */
/* Replay scheduling                                                          */
/* ------------------------------------------------------------------------- */

test("buildReplaySchedule: offsets are relative to the first event", () => {
  const steps = buildReplaySchedule([
    row("a", "2026-08-31T10:00:00.000Z"),
    row("b", "2026-08-31T10:00:01.000Z"),
    row("c", "2026-08-31T10:00:03.500Z"),
  ]);
  assert.deepEqual(
    steps.map((s) => s.atMs),
    [0, 1000, 3500],
  );
  assert.equal(replayDurationMs(steps), 3500);
});

test("buildReplaySchedule: speed divides the offsets", () => {
  const events = [row("a", "2026-08-31T10:00:00.000Z"), row("b", "2026-08-31T10:00:02.000Z")];
  assert.deepEqual(
    buildReplaySchedule(events, { speed: 4 }).map((s) => s.atMs),
    [0, 500],
  );
  // A nonsensical speed falls back to real time rather than dividing by zero.
  assert.deepEqual(
    buildReplaySchedule(events, { speed: 0 }).map((s) => s.atMs),
    [0, 2000],
  );
});

test("buildReplaySchedule: dead air is compressed so replay is watchable", () => {
  const steps = buildReplaySchedule(
    [row("a", "2026-08-31T10:00:00.000Z"), row("b", "2026-08-31T13:00:00.000Z")],
    { maxGapMs: 2000 },
  );
  assert.deepEqual(
    steps.map((s) => s.atMs),
    [0, 2000],
  );
});

test("buildReplaySchedule: unsorted input is ordered, and offsets never go backwards", () => {
  const steps = buildReplaySchedule([
    row("b", "2026-08-31T10:00:02.000Z"),
    row("a", "2026-08-31T10:00:00.000Z"),
  ]);
  assert.deepEqual(
    steps.map((s) => s.event.id),
    ["a", "b"],
  );
  assert.ok(steps[1].atMs >= steps[0].atMs);
});

test("buildReplaySchedule: nothing in, nothing out", () => {
  assert.deepEqual(buildReplaySchedule([]), []);
  assert.equal(replayDurationMs([]), 0);
});

/* ------------------------------------------------------------------------- */
/* Deriving the graph — no actor exists without evidence                      */
/* ------------------------------------------------------------------------- */

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("deriveActors: an installed-but-unused model is a probe-only node", () => {
  const nodes = deriveActors([], { installedModels: ["llama3.2"], now: NOW });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, "ollama:llama3.2");
  assert.equal(nodes[0].label, "llama3.2");
  assert.equal(nodes[0].kind, "local-model");
  assert.equal(nodes[0].probeOnly, true);
  assert.equal(nodes[0].lastEventAt, null);
  assert.equal(nodes[0].inputTokens, null);
});

test("deriveActors: one real event promotes a probe node", () => {
  const nodes = deriveActors(
    [
      row("e1", at(-500), {
        eventType: "llm.request.completed",
        actor: "ollama:llama3.2",
        inputTokens: 900,
        outputTokens: 100,
        estimatedTokensAvoided: 1000,
        summary: "assistant chat turn",
      }),
    ],
    { installedModels: ["llama3.2"], now: NOW },
  );
  assert.equal(nodes[0].probeOnly, false);
  assert.equal(nodes[0].state, "completed");
  assert.equal(nodes[0].inputTokens, 900);
  assert.equal(nodes[0].tokensAvoided, 1000);
  assert.equal(nodes[0].lastSummary, "assistant chat turn");
});

test("deriveActors: states decay rather than making a claim we cannot support", () => {
  const stale = deriveActors(
    [row("e1", at(-COMPLETED_FLASH_MS - 1000), { eventType: "task.completed", actor: "job:PROBE" })],
    { now: NOW },
  );
  assert.equal(stale[0].state, "idle");

  const abandoned = deriveActors(
    [row("e1", at(-WORKING_STALE_MS - 1000), { eventType: "task.started", actor: "job:RENDER" })],
    { now: NOW },
  );
  assert.equal(abandoned[0].state, "idle");

  const running = deriveActors(
    [row("e1", at(-1000), { eventType: "task.started", actor: "job:RENDER" })],
    { now: NOW },
  );
  assert.equal(running[0].state, "working");
});

test("deriveActors: a failure is an error, and a delegation target is the one working", () => {
  const failed = deriveActors([row("e1", at(-100), { eventType: "task.failed" })], { now: NOW });
  assert.equal(failed[0].state, "error");

  const nodes = deriveActors(
    [row("e1", at(-100), { eventType: "delegation.started", actor: "opus", targetActor: "sonnet" })],
    { now: NOW },
  );
  const sonnet = nodes.find((n) => n.id === "sonnet");
  assert.equal(sonnet?.state, "working");
  assert.equal(sonnet?.kind, "session");
});

test("deriveEdges: only delegations that actually happened", () => {
  const edges = deriveEdges([
    row("e1", at(-300), { actor: "opus", targetActor: "sonnet", inputTokens: 100, outputTokens: 20 }),
    row("e2", at(-200), { actor: "opus", targetActor: "sonnet" }),
    row("e3", at(-100), { actor: "job:PROBE" }),
    row("e4", at(-50), { actor: "opus", targetActor: "opus" }),
  ]);
  assert.equal(edges.length, 1);
  assert.deepEqual(
    { from: edges[0].from, to: edges[0].to, count: edges[0].count, tokens: edges[0].tokens },
    { from: "opus", to: "sonnet", count: 2, tokens: 120 },
  );
});

test("deriveEdges: an edge nobody measured reports null tokens, not zero", () => {
  const [edge] = deriveEdges([row("e1", at(-100), { actor: "opus", targetActor: "haiku" })]);
  assert.equal(edge.tokens, null);
});

test("pickOrchestrator: the widest fan-out, or nobody", () => {
  assert.equal(pickOrchestrator([]), null);
  assert.equal(
    pickOrchestrator([
      { from: "opus", to: "sonnet", count: 1, lastAt: 0, tokens: null },
      { from: "opus", to: "haiku", count: 1, lastAt: 0, tokens: null },
      { from: "sonnet", to: "haiku", count: 1, lastAt: 0, tokens: null },
    ]),
    "opus",
  );
});

test("deriveStats: unmeasured totals stay null so the UI can say so", () => {
  const events = [
    row("e1", at(-2000), { eventType: "task.started", actor: "job:PROBE", taskId: "j1" }),
    row("e2", at(-1000), { eventType: "task.started", actor: "job:RENDER", taskId: "j2" }),
    row("e3", at(-500), { eventType: "task.completed", actor: "job:PROBE", taskId: "j1" }),
  ];
  const stats = deriveStats(events, deriveActors(events, { now: NOW }), NOW);
  assert.equal(stats.tasksRunning, 1);
  assert.equal(stats.tasksCompletedToday, 1);
  assert.equal(stats.tasksFailedToday, 0);
  assert.equal(stats.tokensUsed, null);
  assert.equal(stats.avgLatencyMs, null);
  assert.equal(stats.estimatedTokensAvoided, 0);
  assert.equal(stats.eventsInWindow, 3);
});

test("deriveStats: measured totals are summed and averaged", () => {
  const events = [
    row("e1", at(-2000), {
      eventType: "llm.request.completed",
      actor: "ollama:llama3.2",
      inputTokens: 900,
      outputTokens: 100,
      estimatedTokensAvoided: 1000,
      latencyMs: 400,
    }),
    row("e2", at(-1000), {
      eventType: "llm.request.completed",
      actor: "ollama:llama3.2",
      inputTokens: 100,
      outputTokens: 0,
      estimatedTokensAvoided: 100,
      latencyMs: 200,
    }),
  ];
  const stats = deriveStats(events, deriveActors(events, { now: NOW }), NOW);
  assert.equal(stats.tokensUsed, 1100);
  assert.equal(stats.estimatedTokensAvoided, 1100);
  assert.equal(stats.avgLatencyMs, 300);
});

test("pulseIntensity: log-scaled, floored at one, capped", () => {
  assert.equal(pulseIntensity(null), 1);
  assert.equal(pulseIntensity(0), 1);
  assert.ok(pulseIntensity(200) < pulseIntensity(200_000));
  assert.ok(pulseIntensity(200_000_000) <= 12);
  assert.equal(pulseIntensity(200_000_000, 6), 6);
});

/* ------------------------------------------------------------------------- */
/* History query parsing                                                      */
/* ------------------------------------------------------------------------- */

test("parseHistoryQuery: defaults to the last four hours at the row ceiling", () => {
  const q = parseHistoryQuery(new URLSearchParams(), NOW);
  assert.equal(q.limit, HISTORY_MAX_ROWS);
  assert.equal(q.since.getTime(), NOW - HISTORY_DEFAULT_WINDOW_MS);
});

test("parseHistoryQuery: the ceiling cannot be argued up from the query string", () => {
  assert.equal(parseHistoryQuery(new URLSearchParams("limit=999999"), NOW).limit, HISTORY_MAX_ROWS);
  assert.equal(parseHistoryQuery(new URLSearchParams("limit=25"), NOW).limit, 25);
  assert.equal(parseHistoryQuery(new URLSearchParams("limit=nope"), NOW).limit, HISTORY_MAX_ROWS);
  assert.equal(parseHistoryQuery(new URLSearchParams("limit=-5"), NOW).limit, HISTORY_MAX_ROWS);
});

test("parseHistoryQuery: a future or unparseable window falls back rather than erroring", () => {
  const future = parseHistoryQuery(new URLSearchParams("since=2099-01-01T00:00:00.000Z"), NOW);
  assert.equal(future.since.getTime(), NOW);
  const broken = parseHistoryQuery(new URLSearchParams("since=whenever"), NOW);
  assert.equal(broken.since.getTime(), NOW - HISTORY_DEFAULT_WINDOW_MS);
});
