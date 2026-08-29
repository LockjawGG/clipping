import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_TEXT_ANIMATIONS,
  resolveTextAnimation,
  tracksFor,
  needsRemotion,
} from "../src/lib/captions/anim-spec.ts";
import {
  EASINGS,
  springProgress,
  sampleTrack,
  sampleTracks,
  transformCss,
  IDENTITY_TRANSFORM,
} from "../src/lib/captions/anim-eval.ts";
import { captionWordAnim, captionCueAnim } from "../src/lib/captions/anim-dom.ts";
import { remotionPreset, CAPTION_ANIMATIONS } from "../src/lib/captions/presets.ts";

// ---------- easings ----------

test("named easings pin 0 and 1 and stay in range", () => {
  for (const [name, fn] of Object.entries(EASINGS)) {
    assert.equal(fn(0), 0, `${name}(0)`);
    assert.equal(fn(1), 1, `${name}(1)`);
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const v = fn(Math.min(1, p));
      assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `${name}(${p}) = ${v} in [0,1]`);
    }
  }
});

test("springProgress starts at 0, lands near 1, stays bounded", () => {
  const cfg = { damping: 12, stiffness: 200 };
  assert.equal(springProgress(0, cfg), 0);
  const end = springProgress(1, cfg);
  assert.ok(end > 0.85 && end < 1.2, `settles near 1, got ${end}`);
  for (let p = 0; p <= 1; p += 0.05) {
    const v = springProgress(p, cfg);
    assert.ok(v > -0.6 && v < 1.7, `bounded at p=${p}: ${v}`);
  }
});

test("an overdamped spring degrades to ease-out", () => {
  const cfg = { damping: 200, stiffness: 50 }; // zeta >> 1
  for (let p = 0; p <= 1; p += 0.25) {
    assert.ok(Math.abs(springProgress(p, cfg) - EASINGS.out(p)) < 1e-9, `p=${p}`);
  }
});

// ---------- track sampling ----------

test("sampleTrack tweens from->to over its window and clamps outside", () => {
  const t = { prop: "translateY", from: 10, to: 0, startMs: 0, durMs: 100, ease: "linear" } as const;
  assert.equal(sampleTrack(t, 0), 10);
  assert.equal(sampleTrack(t, 50), 5);
  assert.equal(sampleTrack(t, 100), 0);
  assert.equal(sampleTrack(t, 500), 0); // clamped
  assert.equal(sampleTrack(t, -20), 10); // clamped
});

test("a zero-duration track is an instant step", () => {
  const t = { prop: "scale", from: 1.12, to: 1.12, startMs: 0, durMs: 0, ease: "linear" } as const;
  assert.equal(sampleTrack(t, -1), 1.12);
  assert.equal(sampleTrack(t, 0), 1.12);
  const step = { prop: "opacity", from: 0, to: 1, startMs: 0, durMs: 0, ease: "linear" } as const;
  assert.equal(sampleTrack(step, -1), 0);
  assert.equal(sampleTrack(step, 0), 1);
});

test("stagger delays a track by stepMs * unitIndex", () => {
  const t = {
    prop: "opacity",
    from: 0,
    to: 1,
    startMs: 0,
    durMs: 100,
    ease: "linear",
    stagger: { unit: "word", stepMs: 60 },
  } as const;
  assert.equal(sampleTrack(t, 50, 0), 0.5);
  assert.equal(sampleTrack(t, 50, 1), 0); // window shifted +60ms -> local -10ms
  assert.equal(sampleTrack(t, 110, 1), 0.5);
});

test("sampleTracks folds: scale multiplies, translate adds, opacity set", () => {
  const out = sampleTracks(
    [
      { prop: "scale", from: 2, to: 2, durMs: 0, ease: "linear" },
      { prop: "translateY", from: -5, to: -5, durMs: 0, ease: "linear" },
      { prop: "translateY", from: -3, to: -3, durMs: 0, ease: "linear" },
      { prop: "opacity", from: 0.4, to: 0.4, durMs: 0, ease: "linear" },
    ],
    0,
  );
  assert.equal(out.scale, 2);
  assert.equal(out.translateY, -8);
  assert.equal(out.opacity, 0.4);
});

test("transformCss emits none/1 for identity and a filter only when blurred", () => {
  const id = transformCss(IDENTITY_TRANSFORM);
  assert.equal(id.transform, "none");
  assert.equal(id.opacity, 1);
  assert.equal(id.filter, undefined);
  const blur = transformCss({ ...IDENTITY_TRANSFORM, translateY: 4, scale: 1.2, blur: 2 });
  assert.match(blur.transform, /translate\(0px, 4px\) scale\(1\.2\)/);
  assert.equal(blur.filter, "blur(2px)");
});

// ---------- spec registry ----------

test("every animated enum value has a builtin animation whose id is its key", () => {
  for (const a of CAPTION_ANIMATIONS) {
    if (a === "NONE") continue;
    const id = remotionPreset(a);
    const anim = BUILTIN_TEXT_ANIMATIONS[id];
    assert.ok(anim, `builtin for ${a} -> ${id}`);
    assert.equal(anim.id, id);
  }
});

test("resolveTextAnimation falls back to word-by-word for unknown ids", () => {
  assert.equal(resolveTextAnimation("pop").id, "pop");
  assert.equal(resolveTextAnimation("nope").id, "word-by-word");
  assert.equal(resolveTextAnimation(null).id, "word-by-word");
});

test("tracksFor pulls the right scope/phase tracks", () => {
  const pop = tracksFor(resolveTextAnimation("pop"), "word", "intro");
  assert.equal(pop.length, 1);
  assert.equal(pop[0].prop, "scale");
  const slide = tracksFor(resolveTextAnimation("slide-up"), "cue", "intro");
  assert.deepEqual(
    slide.map((t) => t.prop).sort(),
    ["opacity", "translateY"],
  );
  assert.equal(tracksFor(resolveTextAnimation("slide-up"), "word", "intro").length, 0);
});

test("needsRemotion: only real animations (and later, rich styles) need Remotion", () => {
  for (const off of ["NONE", "none", "", null, undefined]) {
    assert.equal(needsRemotion(off as string | null | undefined), false, String(off));
  }
  assert.equal(needsRemotion("pop"), true);
  assert.equal(needsRemotion("word-by-word"), true);
});

// ---------- DOM interpreter ----------

const WORD = { startMs: 1000, endMs: 1400, index: 0 };

test("word-by-word hides a word until it is spoken", () => {
  const before = captionWordAnim("word-by-word", 900, WORD, "hello");
  assert.equal(before.hidden, true);
  assert.equal(before.visibleText, "");
  const after = captionWordAnim("word-by-word", 1200, WORD, "hello");
  assert.equal(after.hidden, false);
  assert.equal(after.visibleText, "hello");
  assert.equal(after.highlighted, true); // active
});

test("typewriter reveals a leading slice of the active word", () => {
  const mid = captionWordAnim("typewriter", 1200, WORD, "elephant");
  assert.ok(mid.visibleText.length > 0 && mid.visibleText.length < "elephant".length);
  assert.ok("elephant".startsWith(mid.visibleText));
  const done = captionWordAnim("typewriter", 1400, WORD, "elephant");
  assert.equal(done.visibleText, "elephant");
});

test("fade ramps opacity in just before the word", () => {
  const early = captionWordAnim("fade", 800, WORD, "hi"); // well before the -120ms window
  assert.ok(early.css.opacity <= 0.01);
  const entering = captionWordAnim("fade", 940, WORD, "hi"); // mid window (880..1000)
  assert.ok(entering.css.opacity > 0.2 && entering.css.opacity < 0.9);
  const spoken = captionWordAnim("fade", 1100, WORD, "hi");
  assert.equal(spoken.css.opacity, 1);
});

test("pop starts scaled up and relaxes toward 1", () => {
  const start = captionWordAnim("pop", 1000, WORD, "wow");
  assert.match(start.css.transform, /scale\(1\.3/); // ~1.35 at elapsed 0
  const later = captionWordAnim("pop", 1350, WORD, "wow");
  const m = later.css.transform.match(/scale\(([\d.]+)\)/);
  assert.ok(m && Number(m[1]) < 1.15, `relaxes, got ${later.css.transform}`);
});

test("karaoke keeps a word highlighted after it is spoken", () => {
  const during = captionWordAnim("karaoke", 1200, WORD, "x");
  const after = captionWordAnim("karaoke", 3000, WORD, "x");
  assert.equal(during.highlighted, true);
  assert.equal(after.highlighted, true);
  // an "active"-highlight preset does not
  assert.equal(captionWordAnim("pop", 3000, WORD, "x").highlighted, false);
});

test("captionCueAnim animates the whole cue for slide-up only", () => {
  const cue = { startMs: 1000, endMs: 3000 };
  const start = captionCueAnim("slide-up", 1000, cue);
  assert.ok(start.opacity < 0.05);
  assert.match(start.transform, /translate\(0px, 2[0-9]/); // ~28px
  const settled = captionCueAnim("slide-up", 2500, cue);
  assert.ok(settled.opacity > 0.9);
  const none = captionCueAnim("pop", 1000, cue);
  assert.equal(none.transform, "none");
  assert.equal(none.opacity, 1);
});
