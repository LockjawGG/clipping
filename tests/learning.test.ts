import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFeatures,
  guessContentType,
  parseFeatures,
  type ClipSnapshot,
  type StyleFeatures,
} from "../src/lib/learning/features.ts";
import {
  buildProfile,
  computeConfidence,
  emptyProfile,
  parseProfile,
  recencyWeight,
  HALF_LIFE_DAYS,
  type WeightedExample,
} from "../src/lib/learning/profile.ts";
import {
  clipLengthBias,
  explainLengthFit,
  explainProfile,
  isUsable,
  learnedDefaults,
  lengthAffinity,
  promptBias,
} from "../src/lib/learning/apply.ts";

const snap = (over: Partial<ClipSnapshot> = {}): ClipSnapshot => ({
  startMs: 0,
  endMs: 20_000,
  aspectRatio: "VERTICAL_9_16",
  captions: {
    enabled: true,
    templateId: "viral-pop-yellow",
    animation: "POP",
    fontFamily: "Archivo Black",
    fontSizePx: 72,
    positionY: 0.78,
    highlightUsed: true,
  },
  overlays: [],
  ...over,
});

/** `n` identical examples, optionally aged. */
const examples = (f: StyleFeatures, n: number, createdAt?: Date): WeightedExample[] =>
  Array.from({ length: n }, () => ({ features: f, createdAt }));

// ---------------------------------------------------------------- extraction

test("extractFeatures reduces a finished clip to a small stored vector", () => {
  const f = extractFeatures(
    snap({
      startMs: 5_000,
      endMs: 27_000,
      removedWordCount: 4,
      focusKeyframeCount: 3,
      maxFocusScale: 1.8,
      censorEnabled: true,
      overlays: [
        { kind: "TEXT", role: "title", intro: "slide-up", loop: "float", outro: "fade" },
        { kind: "IMAGE", intro: "pop", loop: "none", outro: null },
      ],
    }),
  );

  assert.equal(f.pacing.durationMs, 22_000);
  assert.equal(f.pacing.trimmed, true);
  assert.equal(f.captions.templateId, "viral-pop-yellow");
  assert.deepEqual(f.motion.intro, { "slide-up": 1, pop: 1 });
  assert.deepEqual(f.motion.loop, { float: 1 }, `"none" is not a preference`);
  assert.equal(f.motion.textLayerCount, 1);
  assert.equal(f.motion.overlayCount, 2);
  assert.equal(f.framing.captureWindow, true);
  assert.equal(f.framing.maxZoom, 1.8);
  assert.equal(f.polish.censored, true);
});

test("a clip with no captions or overlays extracts cleanly", () => {
  const f = extractFeatures(snap({ captions: null, overlays: [] }));
  assert.equal(f.captions.used, false);
  assert.equal(f.captions.templateId, null);
  assert.deepEqual(f.motion.intro, {});
  assert.equal(f.pacing.trimmed, false);
});

test("parseFeatures rejects junk and future versions", () => {
  const f = extractFeatures(snap());
  assert.deepEqual(parseFeatures(JSON.stringify(f)), f);
  assert.equal(parseFeatures("{ not json"), null);
  assert.equal(parseFeatures(null), null);
  assert.equal(parseFeatures({ ...f, version: 2 }), null);
});

// ------------------------------------------------------------- content type

test("guessContentType stays UNKNOWN unless the signal is fairly clear", () => {
  // A wrong guess files the example under the wrong profile and poisons it.
  assert.equal(guessContentType({ durationMs: null }), "UNKNOWN");
  assert.equal(guessContentType({ durationMs: 5 * 60_000 }), "UNKNOWN", "no speaker signal");
  assert.equal(guessContentType({ durationMs: 30_000 }), "SHORT");
  assert.equal(guessContentType({ durationMs: 40 * 60_000, speakerCount: 2 }), "PODCAST");
  assert.equal(guessContentType({ durationMs: 8 * 60_000, speakerCount: 2 }), "INTERVIEW");
  assert.equal(
    guessContentType({ durationMs: 10 * 60_000, speakerCount: 1, wordsPerMinute: 190 }),
    "COMMENTARY",
  );
  assert.equal(
    guessContentType({ durationMs: 10 * 60_000, speakerCount: 1, wordsPerMinute: 120 }),
    "EDUCATIONAL",
  );
  // Ambiguous pace with one speaker is not guessed at.
  assert.equal(
    guessContentType({ durationMs: 10 * 60_000, speakerCount: 1, wordsPerMinute: 150 }),
    "UNKNOWN",
  );
});

// ------------------------------------------------------------- aggregation

test("a profile learns the median length and the middle band", () => {
  const lens = [10_000, 18_000, 20_000, 22_000, 60_000];
  const p = buildProfile(
    "PODCAST",
    lens.map((ms) => ({ features: extractFeatures(snap({ endMs: ms })) })),
  );
  assert.equal(p.pacing.medianMs, 20_000);
  assert.equal(p.pacing.p25Ms, 18_000);
  assert.equal(p.pacing.p75Ms, 22_000);
  // The 60s outlier moved the band not at all — that is the point of medians.
  assert.ok(p.pacing.p75Ms < 30_000);
});

test("categorical preferences are ranked by share", () => {
  const yellow = extractFeatures(snap());
  const clean = extractFeatures(
    snap({ captions: { enabled: true, templateId: "clean-inter", animation: "NONE" } }),
  );
  const p = buildProfile("PODCAST", [
    ...examples(yellow, 7),
    ...examples(clean, 3),
  ]);
  assert.equal(p.captions.template[0].value, "viral-pop-yellow");
  assert.ok(Math.abs(p.captions.template[0].share - 0.7) < 1e-9);
  assert.equal(p.captions.template[1].value, "clean-inter");
});

test("recency weighting halves at the half-life", () => {
  const now = Date.now();
  assert.equal(recencyWeight(now, now), 1);
  const old = now - HALF_LIFE_DAYS * 86_400_000;
  assert.ok(Math.abs(recencyWeight(old, now) - 0.5) < 1e-6);
  assert.ok(recencyWeight(now - 4 * HALF_LIFE_DAYS * 86_400_000, now) < 0.07);
  assert.equal(recencyWeight(undefined), 1, "an undated example is not penalised");
});

test("recent taste outranks old taste", () => {
  const now = Date.now();
  const oldDate = new Date(now - 3 * HALF_LIFE_DAYS * 86_400_000);
  const newDate = new Date(now);
  const oldStyle = extractFeatures(snap({ captions: { enabled: true, templateId: "old-look" } }));
  const newStyle = extractFeatures(snap({ captions: { enabled: true, templateId: "new-look" } }));

  // Six old edits against three recent ones: recency still wins.
  const p = buildProfile(
    "PODCAST",
    [...examples(oldStyle, 6, oldDate), ...examples(newStyle, 3, newDate)],
    now,
  );
  assert.equal(p.captions.template[0].value, "new-look");
});

test("confidence needs volume, not just agreement", () => {
  // Three examples that agree perfectly are still not a settled style.
  assert.ok(computeConfidence(3, 1) < 0.3);
  // A dozen that agree are.
  assert.ok(computeConfidence(12, 1) > 0.9);
  // A dozen that disagree are trusted less than a dozen that agree.
  assert.ok(computeConfidence(12, 0.2) < computeConfidence(12, 1));
  assert.equal(computeConfidence(0, 0), 0);
});

test("an empty profile is valid and knows it has learned nothing", () => {
  const p = emptyProfile("UNKNOWN");
  assert.equal(p.exampleCount, 0);
  assert.equal(p.confidence, 0);
  assert.equal(p.pacing.medianMs, 0);
  assert.deepEqual(p.captions.template, []);
  assert.deepEqual(explainProfile(p), [], "nothing learned -> nothing claimed");
});

test("profiles round-trip through storage", () => {
  const p = buildProfile("PODCAST", examples(extractFeatures(snap()), 5));
  assert.deepEqual(parseProfile(JSON.stringify(p)), p);
  assert.equal(parseProfile("{ nope"), null);
  assert.equal(parseProfile({ version: 2 }), null);
});

// ----------------------------------------------------------------- applying

test("a low-confidence profile biases nothing at all", () => {
  const thin = buildProfile("PODCAST", examples(extractFeatures(snap()), 2));
  assert.equal(isUsable(thin), false);
  assert.deepEqual(learnedDefaults(thin), {});
  assert.equal(promptBias(thin), null);
  assert.equal(explainLengthFit(thin, 0, 20_000), null);
  const bias = clipLengthBias(thin, { minClipMs: 15_000, maxClipMs: 60_000 });
  assert.equal(bias.learned, false);
  assert.deepEqual([bias.minClipMs, bias.maxClipMs], [15_000, 60_000]);
});

test("a settled profile widens the clip window around what was learned", () => {
  const p = buildProfile(
    "PODCAST",
    [16_000, 18_000, 20_000, 21_000, 22_000, 24_000].flatMap((ms) =>
      examples(extractFeatures(snap({ endMs: ms })), 2),
    ),
  );
  assert.ok(isUsable(p));
  const bias = clipLengthBias(p, { minClipMs: 15_000, maxClipMs: 60_000 });
  assert.equal(bias.learned, true);
  assert.equal(bias.targetMs, p.pacing.medianMs);
  // Widened past the learned band, not clamped to it: the profile describes
  // what the user did, it is not a rule about what they may do.
  assert.ok(bias.minClipMs < p.pacing.p25Ms);
  assert.ok(bias.maxClipMs > p.pacing.p75Ms);
});

test("only dominant preferences become defaults", () => {
  const a = extractFeatures(snap({ captions: { enabled: true, templateId: "aaa" } }));
  const b = extractFeatures(snap({ captions: { enabled: true, templateId: "bbb" } }));

  // A 50/50 split is a coin toss, not a preference.
  const split = buildProfile("PODCAST", [...examples(a, 8), ...examples(b, 8)]);
  assert.equal(learnedDefaults(split).captionTemplateId, undefined);

  // A clear favourite is.
  const clear = buildProfile("PODCAST", [...examples(a, 14), ...examples(b, 2)]);
  assert.equal(learnedDefaults(clear).captionTemplateId, "aaa");
});

test("consistently captionless edits learn to leave captions off", () => {
  const noCaps = extractFeatures(snap({ captions: null }));
  const p = buildProfile("VLOG", examples(noCaps, 15));
  assert.equal(learnedDefaults(p).captionsOn, false);
});

test("the prompt bias is short, specific, and framed as guidance", () => {
  const p = buildProfile(
    "PODCAST",
    examples(extractFeatures(snap({ endMs: 20_000, removedWordCount: 3 })), 15),
  );
  const bias = promptBias(p)!;
  assert.ok(bias);
  assert.match(bias, /guidance, not rules/);
  assert.match(bias, /around 20s/);
  assert.match(bias, /trims filler/);
  assert.ok(bias.split("\n").length <= 6, "a handful of lines, not a specification");
});

test("the profile can say what it learned — the whole point of D1", () => {
  const p = buildProfile(
    "PODCAST",
    examples(
      extractFeatures(
        snap({
          endMs: 21_000,
          focusKeyframeCount: 2,
          maxFocusScale: 1.5,
          overlays: [{ kind: "TEXT", loop: "float" }],
        }),
      ),
      15,
    ),
  );
  const said = explainProfile(p);
  assert.ok(said.length >= 4, said.join(" | "));
  assert.ok(said.some((s) => /typical length of 21s/.test(s)));
  assert.ok(said.some((s) => /viral-pop-yellow \(100%\)/.test(s)));
  assert.ok(said.some((s) => /float \(100%\)/.test(s)));
  assert.ok(said.some((s) => /1\.5×/.test(s)));
  // Every sentence is a real sentence, not a field dump.
  for (const s of said) assert.match(s, /^[A-Z].*\.$/, s);
});

test("length fit reads as silence when the profile has nothing to say", () => {
  const p = buildProfile("PODCAST", examples(extractFeatures(snap({ endMs: 20_000 })), 15));
  assert.match(explainLengthFit(p, 0, 20_000)!, /matches your usual 20s/);
  assert.match(explainLengthFit(p, 0, 5_000)!, /shorter than your usual/);
  assert.match(explainLengthFit(p, 0, 90_000)!, /longer than your usual/);
  assert.equal(explainLengthFit(null, 0, 20_000), null);
});

test("length affinity is ratio-based so it scales with the target", () => {
  const p = buildProfile("PODCAST", examples(extractFeatures(snap({ endMs: 20_000 })), 15));
  assert.equal(lengthAffinity(p, 0, 20_000), 1);
  // 10s off a 20s target hurts more than 10s off a 120s target would.
  assert.ok(Math.abs(lengthAffinity(p, 0, 10_000) - 0.5) < 1e-9);
  assert.ok(Math.abs(lengthAffinity(p, 0, 40_000) - 0.5) < 1e-9);
  // No profile -> neutral, never a penalty.
  assert.equal(lengthAffinity(null, 0, 999_999), 0.5);
});
