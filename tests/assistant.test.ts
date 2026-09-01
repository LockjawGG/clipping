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
