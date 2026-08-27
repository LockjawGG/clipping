import test from "node:test";
import assert from "node:assert/strict";

import {
  attachWordsToSegments,
  groupWordsIntoSegments,
  meanConfidence,
  normalizeLanguage,
  secToMs,
} from "../src/lib/transcription/normalize.ts";
import { parseWhisperJson } from "../src/lib/transcription/whisper-local.ts";
import { parseVerboseJson } from "../src/lib/transcription/openai.ts";
import { parseDeepgramResponse } from "../src/lib/transcription/deepgram.ts";

// --- normalize helpers -------------------------------------------------

test("secToMs rounds to integer milliseconds and floors at zero", () => {
  assert.equal(secToMs(1.2345), 1235);
  assert.equal(secToMs(0), 0);
  assert.equal(secToMs(-3), 0);
  assert.equal(secToMs(Number.NaN), 0);
});

test("normalizeLanguage maps full names and strips region tags", () => {
  assert.equal(normalizeLanguage("english"), "en");
  assert.equal(normalizeLanguage("en-US"), "en");
  assert.equal(normalizeLanguage(undefined), "en");
  assert.equal(normalizeLanguage("pt_BR"), "pt");
});

test("meanConfidence ignores missing values and clamps", () => {
  assert.equal(meanConfidence([]), undefined);
  assert.equal(meanConfidence([undefined, undefined]), undefined);
  assert.equal(meanConfidence([0.8, 1.0]), 0.9);
});

test("groupWordsIntoSegments splits on sentence end and on a long gap", () => {
  const words = [
    { text: "Hello", startMs: 0, endMs: 300 },
    { text: "there.", startMs: 300, endMs: 700 },
    { text: "Now", startMs: 2000, endMs: 2300 }, // 1.3s gap
    { text: "this", startMs: 2300, endMs: 2600 },
  ];
  const segs = groupWordsIntoSegments(words);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, "Hello there.");
  assert.equal(segs[0].words.length, 2);
  assert.equal(segs[1].startMs, 2000);
});

test("attachWordsToSegments routes each word to its time range", () => {
  const bare = [
    { text: "a b", startMs: 0, endMs: 1000 },
    { text: "c d", startMs: 1000, endMs: 2000 },
  ];
  const words = [
    { text: "a", startMs: 0, endMs: 400 },
    { text: "b", startMs: 400, endMs: 900 },
    { text: "c", startMs: 1000, endMs: 1400 },
    { text: "d", startMs: 1400, endMs: 1900 },
  ];
  const segs = attachWordsToSegments(bare, words);
  assert.deepEqual(segs.map((s) => s.words.map((w) => w.text)), [["a", "b"], ["c", "d"]]);
});

// --- whisper-local ---------------------------------------------------

const whisperFixture = {
  language: "english",
  text: " Hello there. Now this.",
  segments: [
    {
      start: 0.0,
      end: 0.72,
      text: " Hello there.",
      avg_logprob: -0.2,
      words: [
        { word: " Hello", start: 0.0, end: 0.34, probability: 0.99 },
        { word: " there.", start: 0.34, end: 0.72, probability: 0.95 },
      ],
    },
    {
      start: 1.9,
      end: 2.6,
      text: " Now this.",
      avg_logprob: -0.5,
      words: [
        { word: " Now", start: 1.9, end: 2.2, probability: 0.9 },
        { word: " this.", start: 2.2, end: 2.6, probability: 0.88 },
      ],
    },
  ],
};

test("parseWhisperJson converts to integer-ms segments with word timings", () => {
  const r = parseWhisperJson(whisperFixture, "large-v3");
  assert.equal(r.provider, "whisper-local");
  assert.equal(r.model, "large-v3");
  assert.equal(r.language, "en");
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].startMs, 0);
  assert.equal(r.segments[0].endMs, 720);
  assert.equal(r.segments[0].text, "Hello there.");
  assert.deepEqual(r.segments[0].words[0], { text: "Hello", startMs: 0, endMs: 340, confidence: 0.99 });
  // avg_logprob -0.2 -> exp() ~ 0.819
  assert.ok(Math.abs(r.segments[0].confidence! - Math.exp(-0.2)) < 1e-9);
  assert.ok(r.confidence! > 0 && r.confidence! < 1);
});

test("parseWhisperJson tolerates a missing segments array", () => {
  const r = parseWhisperJson({ language: "en" }, "tiny");
  assert.deepEqual(r.segments, []);
  assert.equal(r.confidence, undefined);
});

// --- openai verbose_json -------------------------------------------

test("parseVerboseJson attaches the flat word stream to segments", () => {
  const r = parseVerboseJson(
    {
      language: "english",
      text: "Hello there. Bye now.",
      words: [
        { word: "Hello", start: 0.0, end: 0.3 },
        { word: "there", start: 0.3, end: 0.6 },
        { word: "Bye", start: 1.0, end: 1.3 },
        { word: "now", start: 1.3, end: 1.6 },
      ],
      segments: [
        { id: 0, start: 0.0, end: 0.6, text: "Hello there.", avg_logprob: -0.1 },
        { id: 1, start: 1.0, end: 1.6, text: "Bye now.", avg_logprob: -0.15 },
      ],
    },
    "whisper-1",
  );
  assert.equal(r.provider, "openai");
  assert.equal(r.language, "en");
  assert.equal(r.segments.length, 2);
  assert.deepEqual(r.segments[0].words.map((w) => w.text), ["Hello", "there"]);
  assert.deepEqual(r.segments[1].words.map((w) => w.text), ["Bye", "now"]);
  assert.equal(r.segments[1].startMs, 1000);
});

// --- deepgram ------------------------------------------------------

const deepgramFixture = {
  metadata: { model_info: { abc: { name: "nova-2" } } },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: "Hello there. How are you?",
            confidence: 0.97,
            languages: ["en"],
            words: [
              { word: "hello", punctuated_word: "Hello", start: 0.0, end: 0.4, confidence: 0.99, speaker: 0 },
              { word: "there", punctuated_word: "there.", start: 0.4, end: 0.8, confidence: 0.98, speaker: 0 },
              { word: "how", punctuated_word: "How", start: 1.2, end: 1.4, confidence: 0.95, speaker: 1 },
              { word: "are", punctuated_word: "are", start: 1.4, end: 1.6, confidence: 0.96, speaker: 1 },
              { word: "you", punctuated_word: "you?", start: 1.6, end: 1.9, confidence: 0.94, speaker: 1 },
            ],
            paragraphs: {
              paragraphs: [
                { speaker: 0, sentences: [{ text: "Hello there.", start: 0.0, end: 0.8 }] },
                { speaker: 1, sentences: [{ text: "How are you?", start: 1.2, end: 1.9 }] },
              ],
            },
          },
        ],
      },
    ],
  },
};

test("parseDeepgramResponse builds sentence segments with speakers and punctuated words", () => {
  const r = parseDeepgramResponse(deepgramFixture, "nova-2");
  assert.equal(r.provider, "deepgram");
  assert.equal(r.language, "en");
  assert.equal(r.confidence, 0.97);
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].text, "Hello there.");
  assert.equal(r.segments[0].speaker, "speaker_0");
  assert.equal(r.segments[1].speaker, "speaker_1");
  assert.deepEqual(r.segments[0].words.map((w) => w.text), ["Hello", "there."]);
  assert.equal(r.segments[1].words[2].text, "you?");
  assert.equal(r.segments[0].words[0].startMs, 0);
  assert.equal(r.segments[1].words[0].startMs, 1200);
});

test("parseDeepgramResponse falls back to word grouping without paragraphs", () => {
  const r = parseDeepgramResponse(
    {
      results: {
        channels: [
          {
            alternatives: [
              {
                confidence: 0.9,
                words: [
                  { word: "one", start: 0.0, end: 0.3 },
                  { word: "two.", start: 0.3, end: 0.6 },
                  { word: "three", start: 3.0, end: 3.3 },
                ],
              },
            ],
          },
        ],
      },
    },
    "nova-2",
  );
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].text, "one two.");
});
