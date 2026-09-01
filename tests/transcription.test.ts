import test from "node:test";
import assert from "node:assert/strict";

import {
  attachWordsToSegments,
  groupWordsIntoSegments,
  meanConfidence,
  normalizeLanguage,
  secToMs,
} from "../src/lib/transcription/normalize.ts";
import {
  parseWhisperCueEndMs,
  parseWhisperJson,
} from "../src/lib/transcription/whisper-local.ts";
import {
  parseWhisperCppJson,
  fastWhisperCppModel,
  wordsFromTokens,
} from "../src/lib/transcription/whisper-cpp.ts";
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

test("whisper.cpp tokens assemble back into words", () => {
  // whisper.cpp times *tokens*, not words: long words arrive in pieces and
  // punctuation arrives alone. The tokeniser signals a word boundary with a
  // leading space, so that is what the assembly keys on. Shaped exactly like
  // the real `-ojf` output, including the `[_BEG_]` marker it opens with.
  const words = wordsFromTokens([
    { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.71 },
    { text: " Oh", offsets: { from: 1250, to: 1980 }, p: 0.9 },
    { text: " cock", offsets: { from: 5090, to: 5600 }, p: 0.8 },
    { text: "sucker", offsets: { from: 5600, to: 6900 }, p: 0.6 },
    { text: ",", offsets: { from: 6900, to: 6950 }, p: 0.4 },
    { text: " lunch", offsets: { from: 7000, to: 7400 }, p: 0.95 },
  ]);

  assert.deepEqual(
    words.map((w) => w.text),
    ["Oh", "cocksucker,", "lunch"],
    "subword pieces and trailing punctuation belong to the word before them",
  );
  // The word spans from its first piece to its last, punctuation included —
  // a caption highlighting "cock" and leaving "sucker" behind is the failure.
  assert.equal(words[1].startMs, 5090);
  assert.equal(words[1].endMs, 6950);
  // The marker token contributes nothing, not even a leading empty word.
  assert.equal(words[0].text, "Oh");
  assert.equal(words[0].startMs, 1250);
});

test("whisper.cpp JSON parses into segments the rest of the app can use", () => {
  const r = parseWhisperCppJson(
    {
      result: { language: "en" },
      transcription: [
        {
          offsets: { from: 1000, to: 4000 },
          text: " Oh lunch.",
          tokens: [
            { text: " Oh", offsets: { from: 1250, to: 1980 }, p: 0.9 },
            { text: " lunch", offsets: { from: 2000, to: 3900 }, p: 0.8 },
            { text: ".", offsets: { from: 3900, to: 3950 }, p: 0.5 },
          ],
        },
        // A segment that transcribed to nothing should not become an empty cue.
        { offsets: { from: 4000, to: 4500 }, text: "   ", tokens: [] },
      ],
    },
    "ggml-small.bin",
  );

  assert.equal(r.provider, "whisper-cpp");
  assert.equal(r.language, "en");
  assert.equal(r.segments.length, 1, "the empty segment is dropped");
  assert.equal(r.segments[0].text, "Oh lunch.");
  assert.equal(r.segments[0].startMs, 1000);
  assert.equal(r.segments[0].endMs, 4000);
  assert.deepEqual(r.segments[0].words.map((w) => w.text), ["Oh", "lunch."]);
});

test("the faster-whisper helper's JSON parses as the CLI's does", () => {
  // Two engines, one parser. The helper mirrors the CLI's shape on purpose, so
  // what actually has to hold is that a payload shaped the way faster-whisper
  // emits it — floats in seconds, `word` carrying its leading space, a
  // per-segment avg_logprob — comes out as the same integer-ms result. If the
  // helper's shape ever drifts, transcripts silently lose their word timings
  // rather than failing, which is the kind of break nobody notices until the
  // captions are wrong.
  const fromHelper = {
    language: "ko",
    segments: [
      {
        start: 0.42,
        end: 2.6,
        text: " 오늘 실험을 하려고 합니다.",
        avg_logprob: -0.25,
        words: [
          { word: " 오늘", start: 0.42, end: 1.1, probability: 0.91 },
          { word: " 실험을", start: 1.1, end: 2.6, probability: 0.88 },
        ],
      },
    ],
  };

  const r = parseWhisperJson(fromHelper as never, "small");
  assert.equal(r.segments.length, 1);
  const seg = r.segments[0];
  assert.equal(seg.startMs, 420);
  assert.equal(seg.endMs, 2_600);
  assert.equal(seg.text, "오늘 실험을 하려고 합니다.");
  assert.equal(seg.words?.length, 2);
  // The leading space each word carries is the tokeniser's, not the word's.
  assert.equal(seg.words?.[0].text, "오늘");
  assert.equal(seg.words?.[0].startMs, 420);
  assert.equal(seg.words?.[1].endMs, 2_600);
  // avg_logprob is a natural log; it comes back as a 0..1 confidence.
  assert.ok((seg.confidence ?? 0) > 0.7 && (seg.confidence ?? 0) < 0.8);
});

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

test("parseWhisperCueEndMs reads the cue end from a streamed CLI line", () => {
  assert.equal(parseWhisperCueEndMs("[00:00.000 --> 00:05.560]  Hello there"), 5_560);
  // past an hour the CLI adds an HH: field
  assert.equal(parseWhisperCueEndMs("[01:02:03.500 --> 01:02:09.250]  later"), 3_729_250);
});

test("parseWhisperCueEndMs ignores non-cue output", () => {
  assert.equal(parseWhisperCueEndMs("Detected language: English"), null);
  assert.equal(parseWhisperCueEndMs("UserWarning: FP16 is not supported on CPU"), null);
  assert.equal(parseWhisperCueEndMs(""), null);
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

test("lone surrogates are stripped from parsed transcripts (they crash TTS)", () => {
  // Observed live: a Korean transcript carried an unpaired \udc9d and Piper
  // died with "surrogates not allowed" while narrating it.
  const dirty = "가\uDC9D나"; // 가 + lone low surrogate + 나
  const j = parseWhisperJson(
    {
      language: "ko",
      segments: [{ start: 0, end: 1, text: dirty, words: [{ word: dirty, start: 0, end: 1 }] }],
    } as never,
    "medium",
  );
  assert.equal(j.segments[0].text, "가나");
  assert.equal(j.segments[0].words[0].text, "가나");

  const c = parseWhisperCppJson(
    {
      result: { language: "ko" },
      transcription: [
        {
          offsets: { from: 0, to: 1000 },
          text: dirty,
          tokens: [{ text: " " + dirty, offsets: { from: 0, to: 1000 }, p: 0.9 }],
        },
      ],
    } as never,
    "ggml-medium.bin",
  );
  assert.equal(c.segments[0].text, "가나");
  assert.equal(c.segments[0].words[0].text, "가나");
  // A surrogate PAIR (emoji) must survive.
  const ok = parseWhisperJson(
    { language: "en", segments: [{ start: 0, end: 1, text: "hi 😀", words: [] }] } as never,
    "medium",
  );
  assert.equal(ok.segments[0].text, "hi 😀");
});

test("fastWhisperCppModel: small sibling when installed, else null", () => {
  const have = (p: string) => p === "C:/t/whisper/ggml-small.bin";
  // Installed: fast swaps the file.
  assert.equal(
    fastWhisperCppModel("C:/t/whisper/ggml-medium.bin", have),
    "C:/t/whisper/ggml-small.bin",
  );
  // Not installed (the single-exe build): no swap, caller falls back to beam 1.
  assert.equal(fastWhisperCppModel("C:/t/whisper/ggml-medium.bin", () => false), null);
  // Already small, or unrecognized name: nothing to derive.
  assert.equal(fastWhisperCppModel("C:/t/whisper/ggml-small.bin", have), null);
  assert.equal(fastWhisperCppModel("C:/t/whisper/ggml-tiny.bin", () => true), null);
  // large-v3 also has a small sibling.
  assert.equal(fastWhisperCppModel("D:/m/ggml-large-v3.bin", (p: string) => p === "D:/m/ggml-small.bin"), "D:/m/ggml-small.bin");
});
