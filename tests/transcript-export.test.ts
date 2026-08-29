import test from "node:test";
import assert from "node:assert/strict";

import { formatTranscript, type ExportSegmentRow } from "../src/lib/api/transcript.ts";

const ROWS: ExportSegmentRow[] = [
  { index: 0, startMs: 0, endMs: 2500, text: "Hello there.", speaker: null },
  { index: 1, startMs: 2500, endMs: 3_661_000, text: "A much later line.", speaker: "Alex" },
];

test("formatTranscript SRT: numbered cues, comma milliseconds, speaker prefix", () => {
  const out = formatTranscript(ROWS, "srt");
  assert.equal(
    out,
    "1\n00:00:00,000 --> 00:00:02,500\nHello there.\n\n" +
      "2\n00:00:02,500 --> 01:01:01,000\nAlex: A much later line.\n",
  );
});

test("formatTranscript VTT: header, dot milliseconds", () => {
  const out = formatTranscript(ROWS, "vtt");
  assert.ok(out.startsWith("WEBVTT\n\n"));
  assert.ok(out.includes("00:00:00.000 --> 00:00:02.500\nHello there."));
  assert.ok(out.includes("01:01:01.000\nAlex: A much later line."));
});

test("formatTranscript TXT: one line per segment, no timestamps", () => {
  assert.equal(formatTranscript(ROWS, "txt"), "Hello there.\nAlex: A much later line.\n");
});

test("formatTranscript handles an empty transcript", () => {
  assert.equal(formatTranscript([], "srt"), "\n");
  assert.equal(formatTranscript([], "txt"), "\n");
});
