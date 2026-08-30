import test from "node:test";
import assert from "node:assert/strict";

import { censoredIndices, detectSpans, normalizeToken } from "../src/lib/censor/detect.ts";
import { maskWord, maskWords } from "../src/lib/censor/mask.ts";
import { lexiconFor, TIERS_BY_SENSITIVITY } from "../src/lib/censor/lexicon.ts";
import { buildCensorAudioArgs } from "../src/lib/ffmpeg/args.ts";

const w = (text: string, i: number) => ({
  id: `w${i}`,
  text,
  startMs: i * 1000,
  endMs: i * 1000 + 400,
});
const line = (s: string) => s.split(" ").map(w);
const on = { enabled: true, sensitivity: "MEDIUM" as const };

test("normalizeToken keeps the letter core and internal apostrophes", () => {
  assert.equal(normalizeToken("Shit,"), "shit");
  assert.equal(normalizeToken('"WHAT?"'), "what");
  assert.equal(normalizeToken("don't"), "don't", "an internal apostrophe is part of the word");
  assert.equal(normalizeToken("fuckin'"), "fuckin", "a trailing one is punctuation");
  assert.equal(normalizeToken("—"), "");
  assert.equal(normalizeToken("123"), "");
});

test("dropped-g colloquialisms still fold to their stem", () => {
  // "fuckin" only reaches "fuck" via "fucking"; stripping suffixes off the raw
  // token would miss it entirely.
  const hits = detectSpans(line("fuckin' pissin' shittin'"), on).map((s) => s.text);
  assert.deepEqual(hits, ["fuckin'", "pissin'", "shittin'"]);
  assert.equal(detectSpans(line("nothin' doin'"), on).length, 0, "innocent ones are untouched");
});

test("agent nouns and their -ing forms both fold to one stem", () => {
  // Regression: the lexicon listed "motherfucker" but not the stem, so
  // "motherfucker" and "motherfuckers" matched while "motherfucking" did not —
  // stripping "-ing" yields "motherfuck", which was in no list.
  const variants = [
    "motherfucker",
    "motherfuckers",
    "motherfucking",
    "motherfuckin",
    "cocksucker",
    "cocksucking",
    "cocksuckers",
  ];
  const hits = new Set(
    detectSpans(line(variants.join(" ")), { enabled: true, sensitivity: "LOW" }).flatMap((s) =>
      s.text.split(" "),
    ),
  );
  for (const v of variants) assert.ok(hits.has(v), `${v} was not caught`);
});

test("a term and its agent noun share a tier", () => {
  // "wanker" sitting in strong while "wank" sat in common meant "wanking"
  // escaped at LOW while "wanker" did not, which reads as a bug to a user.
  const words = line("wank wanker wanking");
  assert.equal(detectSpans(words, { enabled: true, sensitivity: "LOW" }).length, 0);
  assert.equal(detectSpans(words, { enabled: true, sensitivity: "MEDIUM" }).length, 3);
});

test("detection is whole-word, so innocent words never trip", () => {
  // The Scunthorpe problem: substring matching would ruin all of these.
  const words = line(
    "class assassin passage bassist Scunthorpe hello shitake motherhood cocktail peacock",
  );
  const spans = detectSpans(words, { enabled: true, sensitivity: "HIGH" });
  assert.deepEqual(spans, [], "no false positives");
});

test("inflections fold back to the stem", () => {
  const words = line("fucking shits bitches pissed dickhead");
  const hits = detectSpans(words, on).map((s) => s.text);
  assert.deepEqual(hits, ["fucking", "shits", "bitches", "pissed", "dickhead"]);
});

test("sensitivity selects tiers, not a vague dial", () => {
  const words = line("fuck shit damn");
  const at = (sensitivity: "LOW" | "MEDIUM" | "HIGH") =>
    detectSpans(words, { enabled: true, sensitivity }).map((s) => s.text);
  assert.deepEqual(at("LOW"), ["fuck"], "strong only");
  assert.deepEqual(at("MEDIUM"), ["fuck", "shit"]);
  assert.deepEqual(at("HIGH"), ["fuck", "shit", "damn"]);
});

test("the lexicon ships profanity only — no slurs list", () => {
  // The deliberate scope decision: slur detection is not a lookup, so it is
  // left to a user-authored denyList that gets reviewed before it applies.
  const all = lexiconFor("HIGH");
  assert.ok(all.size > 20, "the list is real");
  for (const tiers of Object.values(TIERS_BY_SENSITIVITY)) {
    assert.ok(tiers.length > 0);
  }
  // A user's own term is caught and tagged as theirs, not as built-in.
  const spans = detectSpans(line("hello frobnicate world"), {
    ...on,
    denyList: ["frobnicate"],
  });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].tier, "custom");
});

test("slurs are caught at every sensitivity, including the most permissive", () => {
  // Sensitivity is a dial for how much ordinary swearing to mask. It is not a
  // reason to let a slur through, so lowering it must not disable them.
  const words = line("nigger faggot retard chink spastic");
  for (const sensitivity of ["LOW", "MEDIUM", "HIGH"] as const) {
    const hits = detectSpans(words, { enabled: true, sensitivity });
    assert.equal(hits.length, 5, sensitivity);
    assert.deepEqual([...new Set(hits.map((h) => h.tier))], ["slur"], sensitivity);
  }
});

test("a slur is still exempt-able per clip, which is how reclaimed use gets through", () => {
  const words = line("nigga dyke queer");
  assert.ok(detectSpans(words, { enabled: true, sensitivity: "LOW" }).length > 0);
  assert.deepEqual(
    detectSpans(words, { enabled: true, sensitivity: "LOW", allowList: ["nigga", "dyke"] }).map(
      (s) => s.text,
    ),
    [],
    "the allow-list overrides the slur tier like any other",
  );
});

test("words whose innocent sense dominates are deliberately absent", () => {
  // A filter that masks "the ace of spades" or "that's lame" gets switched off
  // entirely, which protects nobody. "niggardly" is the classic trap: an
  // unrelated word that a careless list would flag.
  const words = line("spades cracker nip lame fairy dwarf oreo guinea niggardly");
  assert.deepEqual(detectSpans(words, { enabled: true, sensitivity: "HIGH" }), []);
});

test("the allow-list rescues a false positive and beats the deny-list", () => {
  const words = line("what the hell");
  assert.equal(detectSpans(words, { enabled: true, sensitivity: "HIGH" }).length, 1);
  assert.deepEqual(
    detectSpans(words, { enabled: true, sensitivity: "HIGH", allowList: ["hell"] }),
    [],
  );
  // Same term on both lists: allow wins, because that is the escape hatch.
  assert.deepEqual(
    detectSpans(words, { ...on, allowList: ["hell"], denyList: ["hell"] }),
    [],
  );
});

test("disabled config detects nothing at all", () => {
  assert.deepEqual(detectSpans(line("fuck shit"), { enabled: false, sensitivity: "HIGH" }), []);
  assert.equal(censoredIndices(line("fuck"), { enabled: false, sensitivity: "HIGH" }).size, 0);
});

test("spans are padded so the consonant is not left audible", () => {
  const spans = detectSpans([{ text: "shit", startMs: 1000, endMs: 1400 }], on, 60);
  assert.deepEqual([spans[0].startMs, spans[0].endMs], [940, 1460]);
  // Padding never runs before the start of the clip.
  const atZero = detectSpans([{ text: "shit", startMs: 10, endMs: 400 }], on, 60);
  assert.equal(atZero[0].startMs, 0);
});

test("consecutive profanity merges into one bleep, not a stutter", () => {
  const words = [
    { text: "oh", startMs: 0, endMs: 300 },
    { text: "fuck", startMs: 1000, endMs: 1300 },
    { text: "shit", startMs: 1320, endMs: 1600 },
    { text: "later", startMs: 5000, endMs: 5300 },
    { text: "damn", startMs: 6000, endMs: 6300 },
  ];
  const spans = detectSpans(words, { enabled: true, sensitivity: "HIGH" }, 60);
  assert.equal(spans.length, 2, "the adjacent pair merged");
  assert.equal(spans[0].text, "fuck shit");
  assert.equal(spans[0].endMs, 1660);
  assert.equal(spans[1].text, "damn");
});

test("censoredIndices keeps per-word identity that merging would lose", () => {
  const words = line("oh fuck shit later");
  const idx = censoredIndices(words, on);
  assert.deepEqual([...idx].sort(), [1, 2]);
});

test("maskWord preserves punctuation and length", () => {
  assert.equal(maskWord("shit,", "FULL"), "****,");
  assert.equal(maskWord('"Shit!"', "FULL"), '"****!"');
  assert.equal(maskWord("shit", "FIRST"), "s***");
  assert.equal(maskWord("shit", "PARTIAL"), "s**t");
  assert.equal(maskWord("shit", "CUSTOM", "[BLEEP]"), "[BLEEP]");
});

test("PARTIAL degrades on short words rather than leaving them readable", () => {
  // "ass" as s*s would still read; keeping only the first letter does not.
  assert.equal(maskWord("ass", "PARTIAL"), "a**");
  assert.equal(maskWord("at", "PARTIAL"), "a*");
  assert.equal(maskWord("damn", "PARTIAL"), "d**n");
});

test("an empty custom replacement falls back rather than deleting the word", () => {
  assert.equal(maskWord("shit", "CUSTOM", "   "), "****");
  assert.equal(maskWord("shit", "CUSTOM", undefined), "****");
});

test("maskWord leaves a token with no letters alone", () => {
  assert.equal(maskWord("—", "FULL"), "—");
  assert.equal(maskWord("", "FULL"), "");
});

test("maskWords rewrites only the flagged indices", () => {
  const words = line("oh shit really");
  const out = maskWords(words, new Set([1]), "FULL");
  assert.deepEqual(
    out.map((x) => x.text),
    ["oh", "****", "really"],
  );
  // Timings and ids survive, so cue building is unaffected.
  assert.equal(out[1].startMs, words[1].startMs);
  assert.equal(out[1].id, words[1].id);
  // No flags -> the same array, no copying.
  assert.equal(maskWords(words, new Set(), "FULL"), words);
});

test("buildCensorAudioArgs mutes without adding a second input", () => {
  const args = buildCensorAudioArgs({
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    spans: [{ startSec: 1, endSec: 1.5 }],
    mode: "MUTE",
  });
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.match(fc, /volume='if\(between\(t,1,1\.5\),0,1\)':eval=frame/);
  assert.ok(!args.includes("lavfi"), "mute needs no tone generator");
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), ["-c:v", "copy"]);
});

test("buildCensorAudioArgs mixes a gated tone for beep and tone", () => {
  const beep = buildCensorAudioArgs({
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    spans: [{ startSec: 1, endSec: 1.5 }, { startSec: 3, endSec: 3.2 }],
    mode: "BEEP",
  });
  const fc = beep[beep.indexOf("-filter_complex") + 1];
  // Both spans are in one predicate, so the voice ducks and the tone rises together.
  assert.match(fc, /between\(t,1,1\.5\)\+between\(t,3,3\.2\)/);
  assert.match(fc, /amix=inputs=2:duration=first:dropout_transition=0:normalize=0/);
  assert.ok(beep.includes("sine=frequency=1000:sample_rate=48000"));

  const tone = buildCensorAudioArgs({
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    spans: [{ startSec: 1, endSec: 1.5 }],
    mode: "TONE",
  });
  assert.ok(tone.includes("sine=frequency=400:sample_rate=48000"), "tone is the softer 400Hz");
});

test("buildCensorAudioArgs refuses a no-op pass", () => {
  assert.throws(
    () =>
      buildCensorAudioArgs({
        inputPath: "/tmp/in.mp4",
        outputPath: "/tmp/out.mp4",
        spans: [],
        mode: "BEEP",
      }),
    /no censor spans/,
  );
});
