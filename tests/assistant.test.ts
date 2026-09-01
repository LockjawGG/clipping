import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { ollamaStatus, ollamaChat, pickModel } from "../src/lib/llm/ollama.ts";
import { OllamaAnalysisProvider, OllamaWithFallbackProvider } from "../src/lib/analysis/ollama.ts";
import { HeuristicAnalysisProvider } from "../src/lib/analysis/heuristic.ts";
import {
  parseAssistantReply,
  transcriptForPrompt,
  assistantSystemPrompt,
} from "../src/lib/assistant/protocol.ts";
import type { Segment } from "../src/lib/providers/types.ts";

/** A tiny in-process Ollama: /api/tags and /api/chat, scripted per test. */
function mockOllama(reply: (body: Record<string, unknown>) => string) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }, { name: "qwen2.5:7b" }] }));
      return;
    }
    if (req.url === "/api/chat") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ message: { role: "assistant", content: reply(JSON.parse(data)) } }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise<{ baseUrl: string; close: () => void; requests: () => number }>((resolve) => {
    let count = 0;
    server.on("request", () => count++);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        requests: () => count,
      });
    });
  });
}

const seg = (startMs: number, endMs: number, text: string): Segment => ({
  text,
  startMs,
  endMs,
  words: [],
});

test("ollamaStatus: reports models when up, absence when not", async () => {
  const mock = await mockOllama(() => "{}");
  try {
    const up = await ollamaStatus({ baseUrl: mock.baseUrl });
    assert.equal(up.available, true);
    assert.deepEqual(up.models, ["llama3.2:latest", "qwen2.5:7b"]);
  } finally {
    mock.close();
  }
  const down = await ollamaStatus({ baseUrl: "http://127.0.0.1:1" });
  assert.deepEqual(down, { available: false, models: [] });
});

test("pickModel: configured name matches with or without a tag, else first installed", () => {
  const installed = ["llama3.2:latest", "qwen2.5:7b"];
  assert.equal(pickModel("llama3.2", installed), "llama3.2:latest");
  assert.equal(pickModel("qwen2.5:7b", installed), "qwen2.5:7b");
  assert.equal(pickModel("missing-model", installed), "llama3.2:latest");
  assert.equal(pickModel("anything", []), null);
});

test("OllamaAnalysisProvider: speaks the /api/chat contract and parses clips", async () => {
  let sawSystem = "";
  const mock = await mockOllama((body) => {
    const msgs = body.messages as Array<{ role: string; content: string }>;
    sawSystem = msgs.find((m) => m.role === "system")?.content ?? "";
    return JSON.stringify({
      clips: [
        {
          startMs: 1000,
          endMs: 21_000,
          title: "The elephant bit",
          hook: "so here we are",
          description: "the elephants",
          reason: "matches the style rules",
          caption: "elephants!",
          socialTitle: "Elephants",
          hashtags: ["#zoo"],
          score: 0.8,
        },
      ],
    });
  });
  try {
    const provider = new OllamaAnalysisProvider({ baseUrl: mock.baseUrl, model: "llama3.2" });
    const clips = await provider.suggestClips(
      [seg(0, 5000, "here we are in front of the elephants")],
      { minClipMs: 5000, maxClipMs: 60_000, maxClips: 5, style: "always end on a punchline" },
    );
    assert.equal(clips.length, 1);
    assert.equal(clips[0].title, "The elephant bit");
    assert.deepEqual(clips[0].hashtags, ["zoo"]);
    // The style instructions reached the model.
    assert.ok(sawSystem.length > 0);
  } finally {
    mock.close();
  }
});

test("OllamaWithFallbackProvider: absent server falls back to the heuristic", async () => {
  const provider = new OllamaWithFallbackProvider(
    new OllamaAnalysisProvider({ baseUrl: "http://127.0.0.1:1" }),
    new HeuristicAnalysisProvider(),
  );
  const clips = await provider.suggestClips(
    [
      seg(0, 9000, "The secret nobody tells you about editing."),
      seg(9000, 24_000, "Here is why it matters and how to do it."),
    ],
    { minClipMs: 5000, maxClipMs: 60_000, maxClips: 3 },
  );
  assert.ok(clips.length > 0, "the heuristic answered when ollama was absent");
});

test("parseAssistantReply: keeps good proposals, drops bad, survives non-JSON", () => {
  const good = parseAssistantReply(
    JSON.stringify({
      reply: "Two ideas.",
      proposals: [
        { action: "create_clip", startMs: 0, endMs: 8000, title: "Opener", reason: "strong hook" },
        { action: "create_clip", startMs: 9000, endMs: 4000, title: "bad", reason: "inverted" },
        { action: "add_censor_word", word: "  Frick ", reason: "profanity rule" },
        { action: "reformat_disk", reason: "nope" },
      ],
    }),
    19_000,
  );
  assert.equal(good.reply, "Two ideas.");
  assert.equal(good.proposals.length, 2);
  assert.equal(good.proposals[0].action, "create_clip");
  assert.deepEqual(good.proposals[1], {
    action: "add_censor_word",
    word: "frick",
    reason: "profanity rule",
  });

  // endMs past the video is clamped, not dropped.
  const clamped = parseAssistantReply(
    JSON.stringify({
      reply: "x",
      proposals: [
        { action: "create_clip", startMs: 15_000, endMs: 60_000, title: "End", reason: "outro" },
      ],
    }),
    19_000,
  );
  assert.equal(clamped.proposals[0].action, "create_clip");
  assert.equal((clamped.proposals[0] as { endMs: number }).endMs, 19_000);

  const prose = parseAssistantReply("I could not produce JSON, sorry.", 19_000);
  assert.equal(prose.reply, "I could not produce JSON, sorry.");
  assert.deepEqual(prose.proposals, []);
});

test("transcriptForPrompt: short transcripts pass whole, long ones keep head, middle and tail", () => {
  const short = transcriptForPrompt([{ startMs: 0, text: "hello" }]);
  assert.equal(short, "[00:00] hello");

  const many = Array.from({ length: 500 }, (_, i) => ({
    startMs: i * 4000,
    text: `line number ${i} with some padding words to take space`,
  }));
  const out = transcriptForPrompt(many, 3000);
  assert.ok(out.length < 3600, "stays near the budget");
  assert.ok(out.includes("line number 0 "), "keeps the start");
  assert.ok(out.includes("line number 499 "), "keeps the end");
  assert.ok(out.includes("[…]"), "marks the elisions");
});

test("assistantSystemPrompt: style rules are injected verbatim", () => {
  const sys = assistantSystemPrompt({
    videoTitle: "Me at the zoo",
    durationMs: 19_000,
    transcript: "[00:00] hi",
    clips: "",
    styleInstructions: "clips 20-40s, always end on a punchline",
  });
  assert.ok(sys.includes("always end on a punchline"));
  assert.ok(sys.includes("Me at the zoo"));
  assert.ok(sys.includes("create_clip"));
});

test("ollamaChat: surfaces server errors with detail", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.end("model exploded");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      () =>
        ollamaChat({
          baseUrl: `http://127.0.0.1:${port}`,
          model: "m",
          system: "s",
          messages: [{ role: "user", content: "hi" }],
        }),
      /500: model exploded/,
    );
  } finally {
    server.close();
  }
});

test("parseAssistantReply survives the small-model failure zoo", () => {
  // Fixture scenarios drafted by the local model (scripts/dev-local-llm.mjs),
  // reviewed and corrected by hand — it helpfully demonstrated its own point
  // by wrapping the output in the exact fences it was told to avoid.
  const dur = 30_000;

  // Valid JSON inside markdown fences: parsed, not treated as prose.
  const fenced = parseAssistantReply(
    '```json\n{"reply": "fenced but fine", "proposals": []}\n```',
    dur,
  );
  assert.equal(fenced.reply, "fenced but fine");

  // Trailing comma = invalid JSON: falls back to showing the raw text.
  const trailing = parseAssistantReply('{"reply": "x", "proposals": [],}', dur);
  assert.ok(trailing.reply.length > 0);
  assert.deepEqual(trailing.proposals, []);

  // proposals as an object, reply as a number, extra unknown keys: lenient.
  const objProposals = parseAssistantReply('{"reply": "ok", "proposals": {"a": 1}}', dur);
  assert.equal(objProposals.reply, "ok");
  assert.deepEqual(objProposals.proposals, []);
  const numReply = parseAssistantReply('{"reply": 42, "proposals": []}', dur);
  assert.equal(numReply.reply, "");
  const extraKey = parseAssistantReply('{"reply": "ok", "proposals": [], "mood": "smug"}', dur);
  assert.equal(extraKey.reply, "ok");

  // Empty string: empty reply, no proposals, no crash.
  const empty = parseAssistantReply("", dur);
  assert.deepEqual(empty, { reply: "", proposals: [] });
});

test("review regressions: clamp cannot produce an empty clip; bare-array roots degrade", () => {
  // Sonnet-review finding 1: a clip starting at the video's end used to clamp
  // into a zero-length proposal that could never be approved.
  const stuck = parseAssistantReply(
    JSON.stringify({
      reply: "outro",
      proposals: [
        { action: "create_clip", startMs: 19_000, endMs: 25_000, title: "End", reason: "outro" },
      ],
    }),
    19_000,
  );
  assert.deepEqual(stuck.proposals, []);

  // Finding 2: valid JSON with a non-object root used to throw out of the route.
  const bareArray = parseAssistantReply(
    JSON.stringify([
      { action: "add_censor_word", word: "Dang", reason: "style rule" },
    ]),
    19_000,
  );
  assert.equal(bareArray.proposals.length, 1);
  const nullRoot = parseAssistantReply("null", 19_000);
  assert.deepEqual(nullRoot.proposals, []);
  const numberRoot = parseAssistantReply("42", 19_000);
  assert.deepEqual(numberRoot.proposals, []);
});

// --- token accounting: Ollama's own counts, not our guesses -----------

/** A /api/chat mock that answers with whatever usage fields are given. */
async function mockCountingOllama(usage: Record<string, number>) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
      return;
    }
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          message: { role: "assistant", content: JSON.stringify({ clips: [] }) },
          ...usage,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("ollamaChat: surfaces Ollama's own token counts and a measured latency", async () => {
  const mock = await mockCountingOllama({ prompt_eval_count: 812, eval_count: 96 });
  try {
    const out = await ollamaChat({
      baseUrl: mock.baseUrl,
      model: "llama3.2",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.inputTokens, 812);
    assert.equal(out.outputTokens, 96);
    assert.ok(out.latencyMs >= 0);
    assert.ok(out.content.length > 0);
  } finally {
    mock.close();
  }
});

test("ollamaChat: a server that reports no counts yields undefined, never zero", async () => {
  const mock = await mockCountingOllama({});
  try {
    const out = await ollamaChat({
      baseUrl: mock.baseUrl,
      model: "llama3.2",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.inputTokens, undefined);
    assert.equal(out.outputTokens, undefined);
  } finally {
    mock.close();
  }
});

test("OllamaAnalysisProvider: reports the real counts, and the whole call as avoided", async () => {
  const mock = await mockCountingOllama({ prompt_eval_count: 4000, eval_count: 500 });
  const events: Array<Record<string, unknown>> = [];
  try {
    const provider = new OllamaAnalysisProvider({
      baseUrl: mock.baseUrl,
      model: "llama3.2",
      onTelemetry: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    await provider.suggestClips([seg(0, 5000, "hello")], {
      minClipMs: 5000,
      maxClipMs: 60_000,
      maxClips: 5,
      style: "",
    });
  } finally {
    mock.close();
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "llm.request.completed");
  assert.equal(events[0].actor, "ollama:llama3.2:latest");
  assert.equal(events[0].summary, "clip suggestions");
  assert.equal(events[0].inputTokens, 4000);
  assert.equal(events[0].outputTokens, 500);
  // Overhead 0: none of this reached a top-tier model, so the whole call counts.
  assert.equal(events[0].estimatedTokensAvoided, 4500);
});

test("OllamaAnalysisProvider: an uncounted call reports no saving rather than zero", async () => {
  const mock = await mockCountingOllama({});
  const events: Array<Record<string, unknown>> = [];
  try {
    const provider = new OllamaAnalysisProvider({
      baseUrl: mock.baseUrl,
      model: "llama3.2",
      onTelemetry: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    await provider.suggestClips([seg(0, 5000, "hello")], {
      minClipMs: 5000,
      maxClipMs: 60_000,
      maxClips: 5,
      style: "",
    });
  } finally {
    mock.close();
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].estimatedTokensAvoided, undefined);
});
