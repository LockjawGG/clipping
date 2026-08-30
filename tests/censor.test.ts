import test from "node:test";
import assert from "node:assert/strict";

import {
  censoredIndices,
  audioSpans,
  censorHasAudioWork,
  censorHasWork,
  detectSpans,
  splitCensoredRuns,
  normalizeToken,
} from "../src/lib/censor/detect.ts";
import { maskWord, maskWords } from "../src/lib/censor/mask.ts";
import { lexiconFor, TIERS_BY_SENSITIVITY } from "../src/lib/censor/lexicon.ts";
import {
  buildCensorAudioArgs,
  buildToneWavArgs,
  buildTrimSilenceArgs,
} from "../src/lib/ffmpeg/args.ts";
import { parseWordOverrides, serializeWordOverrides } from "../src/lib/censor/overrides.ts";

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

test("a hand-picked word is censored even with detection switched off", () => {
  // The toggle governs *finding* words. A word the user pointed at is an
  // explicit instruction and must survive turning detection off, or the mark
  // would silently do nothing.
  const words = line("hello shit world");
  const off = { enabled: false, sensitivity: "HIGH" as const };

  assert.deepEqual(detectSpans(words, off), [], "nothing is auto-detected");

  const manual = detectSpans(words, { ...off, censorWordIds: ["w0"] });
  assert.equal(manual.length, 1);
  assert.equal(manual[0].text, "hello");
  assert.equal(manual[0].tier, "manual");
  // The profanity is still not caught: detection really is off.
  assert.ok(!manual.some((s) => s.text === "shit"));
  assert.deepEqual([...censoredIndices(words, { ...off, censorWordIds: ["w0"] })], [0]);
});

test("censorHasWork distinguishes idle from off-but-marked", () => {
  const base = { enabled: false, sensitivity: "HIGH" as const };
  assert.equal(censorHasWork(base), false, "nothing to do");
  assert.equal(censorHasWork({ ...base, censorWordIds: ["w1"] }), true, "a hand-picked word");
  assert.equal(censorHasWork({ ...base, enabled: true }), true);
  // Term lists alone do nothing while detection is off.
  assert.equal(censorHasWork({ ...base, denyList: ["banana"] }), false);
});

test("a single occurrence can be exempted without touching the others", () => {
  // The whole point of per-instance control: same word, different decisions.
  const words = line("damn it damn again");
  const cfg = { enabled: true, sensitivity: "HIGH" as const };
  assert.equal(detectSpans(words, cfg).length, 2, "both caught by default");

  const oneOff = detectSpans(words, { ...cfg, exemptWordIds: ["w0"] });
  assert.equal(oneOff.length, 1);
  assert.equal(oneOff[0].wordId, "w2", "the second damn is still censored");
});

test("a single occurrence can be censored without censoring the word everywhere", () => {
  const words = line("hello world hello");
  const cfg = { enabled: true, sensitivity: "HIGH" as const };
  assert.deepEqual(detectSpans(words, cfg), [], "nothing is profane here");

  const hits = detectSpans(words, { ...cfg, censorWordIds: ["w2"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].wordId, "w2");
  assert.equal(hits[0].tier, "manual", "tagged as a hand-picked occurrence");
});

test("per-occurrence decisions beat the term lists, which beat the lexicon", () => {
  const cfg = { enabled: true, sensitivity: "HIGH" as const };

  // An exempt id survives the word also being on the deny list.
  assert.deepEqual(
    detectSpans(line("shit"), { ...cfg, denyList: ["shit"], exemptWordIds: ["w0"] }),
    [],
  );
  // A censored id survives the word also being on the allow list.
  const forced = detectSpans(line("shit"), {
    ...cfg,
    allowList: ["shit"],
    censorWordIds: ["w0"],
  });
  assert.equal(forced.length, 1);
  assert.equal(forced[0].tier, "manual");
  // With neither override, the term lists still decide as before.
  assert.deepEqual(detectSpans(line("shit"), { ...cfg, allowList: ["shit"] }), []);
});

test("censoredIndices honours per-occurrence decisions too", () => {
  // The two entry points must agree, or the transcript would mark one thing and
  // the render would mask another.
  const words = line("damn it damn");
  const cfg = { enabled: true, sensitivity: "HIGH" as const, exemptWordIds: ["w0"] };
  assert.deepEqual([...censoredIndices(words, cfg)], [2]);
  assert.deepEqual(
    detectSpans(words, cfg).map((s) => s.index),
    [2],
  );
});

test("word ids only matter when the word has one", () => {
  // Render-path words can arrive without ids; overrides must then be inert
  // rather than throwing or matching everything.
  const anon = [{ text: "damn", startMs: 0, endMs: 100 }];
  assert.equal(
    detectSpans(anon, { enabled: true, sensitivity: "HIGH", exemptWordIds: ["w0"] }).length,
    1,
  );
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

test("the audio half is a subset of the mask, decided per occurrence", () => {
  const words = [
    { id: "w1", text: "shit", startMs: 0, endMs: 400 },
    { id: "w2", text: "fine", startMs: 500, endMs: 800 },
    { id: "w3", text: "shit", startMs: 900, endMs: 1200 },
  ];
  const on = { enabled: true, sensitivity: "MEDIUM" as const };

  assert.equal(detectSpans(words, on).length, 2, "both are masked");
  assert.equal(audioSpans(words, on).length, 2, "and both bleeped by default");

  // One kept audible: still masked, no longer bleeped.
  const split = { ...on, audioExemptWordIds: ["w1"] };
  assert.equal(detectSpans(words, split).length, 2, "the mask is unchanged");
  const heard = audioSpans(words, split);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].wordId, "w3");

  // The clip-wide switch is only a default; a forced word beats it.
  const off = { ...on, audioEnabled: false };
  assert.equal(audioSpans(words, off).length, 0);
  assert.equal(detectSpans(words, off).length, 2, "captions are still masked");
  assert.equal(audioSpans(words, { ...off, audioForceWordIds: ["w1"] }).length, 1);
});

test("censorHasAudioWork separates 'nothing to bleep' from 'bleep is off'", () => {
  const base = { enabled: true, sensitivity: "MEDIUM" as const };
  assert.equal(censorHasAudioWork(base), true);
  assert.equal(censorHasAudioWork({ ...base, audioEnabled: false }), false);
  assert.equal(
    censorHasAudioWork({ ...base, audioEnabled: false, audioForceWordIds: ["w1"] }),
    true,
    "a single forced word is still work",
  );
  assert.equal(
    censorHasAudioWork({ enabled: false, sensitivity: "MEDIUM", audioForceWordIds: ["w1"] }),
    true,
    "an audio-only mark is work in its own right, masking nothing",
  );
});

test("mask and bleep are independent axes, all four combinations reachable", () => {
  const words = [
    { id: "w1", text: "shit", startMs: 0, endMs: 400 },
    // Well clear of w1: spans within 60ms of padding of each other merge, and
    // this test is about membership, not merging.
    { id: "w2", text: "hello", startMs: 2_000, endMs: 2_300 },
  ];
  const on = { enabled: true, sensitivity: "MEDIUM" as const };

  // masked + bleeped: the ordinary case, no overrides at all.
  assert.deepEqual(detectSpans(words, on).map((s) => s.wordId), ["w1"]);
  assert.deepEqual(audioSpans(words, on).map((s) => s.wordId), ["w1"]);

  // masked, audible.
  const quiet = { ...on, audioExemptWordIds: ["w1"] };
  assert.deepEqual(detectSpans(words, quiet).map((s) => s.wordId), ["w1"]);
  assert.deepEqual(audioSpans(words, quiet), []);

  // bleeped, unmasked — an ordinary word silenced without touching the captions.
  const loud = { ...on, audioForceWordIds: ["w2"] };
  assert.deepEqual(detectSpans(words, loud).map((s) => s.wordId), ["w1"], "w2 is not masked");
  assert.deepEqual(audioSpans(words, loud).map((s) => s.wordId), ["w1", "w2"]);

  // an audio-only mark is work even with detection entirely off.
  const only = { enabled: false, sensitivity: "MEDIUM" as const, audioForceWordIds: ["w2"] };
  assert.equal(censorHasWork(only), true);
  assert.deepEqual(detectSpans(words, only), [], "nothing is masked");
  assert.deepEqual(audioSpans(words, only).map((s) => s.wordId), ["w2"]);
});

test("the clip-wide bleep switch is a default the per-word ticks override", () => {
  const words = [{ id: "w1", text: "shit", startMs: 0, endMs: 400 }];
  const off = { enabled: true, sensitivity: "MEDIUM" as const, audioEnabled: false };
  assert.deepEqual(detectSpans(words, off).map((s) => s.wordId), ["w1"], "still masked");
  assert.deepEqual(audioSpans(words, off), [], "not bleeped");
  assert.deepEqual(
    audioSpans(words, { ...off, audioForceWordIds: ["w1"] }).map((s) => s.wordId),
    ["w1"],
    "a ticked word beats the switch",
  );
});

test("each span carries its own sound, so one word can differ from the next", () => {
  const args = buildCensorAudioArgs({
    inputPath: "C:/tmp/in.mp4",
    outputPath: "C:/tmp/out.mp4",
    mode: "BEEP",
    spans: [
      { startSec: 1, endSec: 2 },                 // follows the clip: beep
      { startSec: 3, endSec: 4, mode: "TONE" },
      { startSec: 5, endSec: 6, mode: "MUTE" },
      { startSec: 7, endSec: 8, mode: "BEEP" },
    ],
  });
  const filter = args[args.indexOf("-filter_complex") + 1];

  // One generator per distinct tone, not per span.
  const sines = args.filter((a) => a.startsWith("sine=frequency="));
  assert.deepEqual(sines, [
    "sine=frequency=1000:sample_rate=48000",
    "sine=frequency=400:sample_rate=48000",
  ]);

  // The 1 kHz generator is gated by both beep spans and neither of the others.
  assert.match(filter, /\[1:a\]volume='if\(between\(t,1,2\)\+between\(t,7,8\),0\.8,0\)'/);
  assert.match(filter, /\[2:a\]volume='if\(between\(t,3,4\),0\.5,0\)'/);
  // The muted span still ducks the voice, it just has nothing mixed over it.
  assert.match(filter, /\[0:a\]volume='if\(.*between\(t,5,6\).*,0,1\)'/);
  assert.match(filter, /\[voice\]\[bleep1\]\[bleep2\]amix=inputs=3:.*normalize=0/);
});

test("all-muted spans mix nothing in at all", () => {
  const args = buildCensorAudioArgs({
    inputPath: "C:/tmp/in.mp4",
    outputPath: "C:/tmp/out.mp4",
    mode: "BEEP",
    spans: [{ startSec: 1, endSec: 2, mode: "MUTE" }],
  });
  assert.equal(args.filter((a) => a.startsWith("sine=")).length, 0, "no generator is created");
  assert.ok(!args.join(" ").includes("amix"), "and nothing to mix");
  assert.match(args[args.indexOf("-filter_complex") + 1], /\[voice\]$/);
});

test("touching words with different sounds are not merged into one span", () => {
  const words = [
    { id: "n1", text: "shit", startMs: 1_000, endMs: 1_400 },
    { id: "n2", text: "fuck", startMs: 1_420, endMs: 1_800 },
  ];
  const cfg = {
    enabled: true,
    sensitivity: "MEDIUM" as const,
    wordOverrides: { n2: { audioMode: "MUTE" as const } },
  };
  const spans = audioSpans(words, cfg);
  assert.equal(spans.length, 2, "a merge here would silently change one word's sound");
  assert.equal(spans[0].audioMode, undefined, "the first follows the clip");
  assert.equal(spans[1].audioMode, "MUTE");

  // With the same sound they do merge, as before.
  assert.equal(audioSpans(words, { enabled: true, sensitivity: "MEDIUM" }).length, 1);
});

test("word overrides survive a round trip and drop anything unrecognised", () => {
  const json = serializeWordOverrides({
    w1: { audioMode: "TONE", captionMode: "CUSTOM", replacement: "[REDACTED]" },
    w2: {},
    w3: { replacement: "" },
  });
  assert.deepEqual(parseWordOverrides(json), {
    w1: { audioMode: "TONE", captionMode: "CUSTOM", replacement: "[REDACTED]" },
  });
  assert.equal(serializeWordOverrides({}), null, "nothing overridden is one value, not two");

  // A render must never fail on a column it cannot read.
  assert.deepEqual(parseWordOverrides("not json"), {});
  assert.deepEqual(parseWordOverrides('{"w":{"audioMode":"KAZOO"}}'), {});
  assert.deepEqual(parseWordOverrides('["nope"]'), {});
  assert.deepEqual(parseWordOverrides(null), {});
});

test("an audio-only occurrence is still discoverable, not just audible", () => {
  // The review panel lists the union of these two, so a word that is bleeped
  // without being masked cannot slip through unlisted.
  const words = [
    { id: "r1", text: "shit", startMs: 0, endMs: 400 },
    { id: "r2", text: "hello", startMs: 2_000, endMs: 2_300 },
  ];
  const cfg = {
    enabled: true,
    sensitivity: "MEDIUM" as const,
    exemptWordIds: ["r1"],
    audioForceWordIds: ["r1", "r2"],
  };
  assert.deepEqual(detectSpans(words, cfg), [], "neither is masked");
  assert.deepEqual(
    audioSpans(words, cfg).map((s) => s.wordId),
    ["r1", "r2"],
    "but both are silenced, so both must be listed somewhere",
  );
});

test("keeping an occurrence takes it out of both halves at once", () => {
  // What the review panel's "Keep it" writes: cleared from both force lists,
  // added to both exempt lists. The occurrence must then be untouched no
  // matter which half had been marking it.
  const words = [{ id: "k1", text: "shit", startMs: 0, endMs: 400 }];
  const kept = {
    enabled: true,
    sensitivity: "MEDIUM" as const,
    exemptWordIds: ["k1"],
    audioExemptWordIds: ["k1"],
    censorWordIds: [],
    audioForceWordIds: [],
  };
  assert.deepEqual(detectSpans(words, kept), [], "not masked");
  assert.deepEqual(audioSpans(words, kept), [], "and not bleeped");

  // The exemptions have to beat the clip-wide default too, or "keep it" would
  // come undone the moment the audio switch was turned on.
  assert.deepEqual(audioSpans(words, { ...kept, audioEnabled: true }), []);
});

test("written text splits into clean runs and censored ones", () => {
  const on = { enabled: true, sensitivity: "MEDIUM" as const };
  assert.deepEqual(splitCensoredRuns("The narrator says shit on purpose.", on), [
    { text: "The narrator says ", censored: false },
    { text: "shit ", censored: true },
    { text: "on purpose.", censored: false },
  ]);

  // Consecutive profanity is one run, so it becomes one bleep rather than two
  // abutting ones.
  assert.deepEqual(splitCensoredRuns("two fucking shit words", on), [
    { text: "two ", censored: false },
    { text: "fucking shit ", censored: true },
    { text: "words", censored: false },
  ]);

  // Clean text is a single run: nothing to split, nothing to re-synthesise.
  assert.deepEqual(splitCensoredRuns("nothing objectionable here", on), [
    { text: "nothing objectionable here", censored: false },
  ]);

  // With detection off, narration is left exactly as written.
  assert.deepEqual(
    splitCensoredRuns("says shit", { enabled: false, sensitivity: "MEDIUM" }),
    [{ text: "says shit", censored: false }],
  );

  // The clip's own allow-list rescues a word here too.
  assert.deepEqual(
    splitCensoredRuns("says shit", { ...on, allowList: ["shit"] }),
    [{ text: "says shit", censored: false }],
  );
});

test("a narration bleep is written at the voice's own rate", () => {
  const args = buildToneWavArgs({
    outputPath: "/tmp/bleep.wav",
    durationMs: 340,
    sampleRate: 22_050,
  });
  // The rate has to match the speech it is spliced between, or the join
  // resamples and the line's pitch shifts at the seam.
  assert.ok(args.some((a) => a.includes("sample_rate=22050")));
  assert.ok(args.some((a) => a.includes("frequency=1000")));
  assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "0.340"]);
  // Mono 16-bit PCM, the same shape Piper writes.
  assert.ok(args.includes("-ac") && args.includes("1"));
  assert.ok(args.includes("pcm_s16le"));

  // The softer tone and silence are the same call with different numbers.
  const soft = buildToneWavArgs({ outputPath: "/tmp/b.wav", durationMs: 100, sampleRate: 22_050, hz: 400 });
  assert.ok(soft.some((a) => a.includes("frequency=400")));
  const mute = buildToneWavArgs({ outputPath: "/tmp/b.wav", durationMs: 100, sampleRate: 22_050, gain: 0 });
  assert.ok(mute.some((a) => a === "volume=0"));

  // A zero-length or rate-less tone is a caller bug, not something to emit.
  assert.throws(() => buildToneWavArgs({ outputPath: "/tmp/b.wav", durationMs: 0, sampleRate: 22_050 }));
  assert.throws(() => buildToneWavArgs({ outputPath: "/tmp/b.wav", durationMs: 100, sampleRate: 0 }));
});

test("trimming silence takes the edges only, never the pauses inside", () => {
  const args = buildTrimSilenceArgs({ inputPath: "/tmp/in.wav", outputPath: "/tmp/out.wav" });
  const af = args[args.indexOf("-af") + 1];

  // Leading edge, then the same again through a reverse for the trailing one:
  // silenceremove only looks forward.
  assert.equal((af.match(/silenceremove/g) ?? []).length, 2);
  assert.equal((af.match(/areverse/g) ?? []).length, 2);
  // start_periods=1 stops after the first run of silence, which is what keeps
  // a deliberate pause mid-sentence intact.
  assert.ok(!af.includes("stop_periods"));
  assert.match(af, /start_periods=1/);
  assert.match(af, /start_threshold=-45dB/);
  assert.ok(args.includes("pcm_s16le"));
});
