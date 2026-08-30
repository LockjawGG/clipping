import test from "node:test";
import assert from "node:assert/strict";

import {
  parseElementAnim,
  serializeElementAnim,
  sampleElementAnim,
  ELEMENT_INTROS,
  ELEMENT_OUTROS,
  ELEMENT_LOOPS,
  ELEMENT_INTRO_OPTIONS,
  ELEMENT_OUTRO_OPTIONS,
  ELEMENT_LOOP_OPTIONS,
} from "../src/lib/captions/element-anim.ts";

test("parseElementAnim tolerates null / garbage / partial", () => {
  assert.deepEqual(parseElementAnim(null), {});
  assert.deepEqual(parseElementAnim("nope"), {});
  assert.deepEqual(parseElementAnim("[1]"), {});
  assert.deepEqual(parseElementAnim('{"intro":"fade"}'), { intro: "fade" });
  assert.deepEqual(parseElementAnim('{"intro":1,"outro":"fade"}'), { outro: "fade" });
});

test("serializeElementAnim drops none / unknown, null when empty", () => {
  assert.equal(serializeElementAnim({}), null);
  assert.equal(serializeElementAnim({ intro: "none", outro: "none" }), null);
  assert.equal(serializeElementAnim({ intro: "bogus" }), null);
  assert.equal(serializeElementAnim({ intro: "pop" }), '{"intro":"pop"}');
  assert.equal(serializeElementAnim({ intro: "fade", outro: "slide-up" }), '{"intro":"fade","outro":"slide-up"}');
});

test("option lists include None first and cover the registries", () => {
  assert.equal(ELEMENT_INTRO_OPTIONS[0].id, "none");
  assert.equal(ELEMENT_OUTRO_OPTIONS[0].id, "none");
  assert.equal(ELEMENT_LOOP_OPTIONS[0].id, "none");
  assert.ok(ELEMENT_INTRO_OPTIONS.some((o) => o.id === "slide-up"));
  assert.ok(ELEMENT_OUTRO_OPTIONS.some((o) => o.id === "zoom-out"));
  assert.ok(ELEMENT_LOOP_OPTIONS.some((o) => o.id === "float"));
});

test("the motion catalogue covers every advertised preset", () => {
  for (const id of ["bounce-in", "rotate-in", "spin-in"]) {
    assert.ok(ELEMENT_INTROS[id]?.length, `missing intro ${id}`);
  }
  for (const id of ["bounce-out", "rotate-out", "spin-out"]) {
    assert.ok(ELEMENT_OUTROS[id]?.length, `missing outro ${id}`);
  }
  for (const id of ["drift", "orbit", "pan", "shake", "bobbing", "slow-zoom"]) {
    assert.ok(ELEMENT_LOOPS[id]?.length, `missing loop ${id}`);
  }
  // Every preset must animate a prop the evaluator understands, or it silently
  // does nothing at render time.
  const props = new Set(["opacity", "translateX", "translateY", "scale", "rotate", "blur"]);
  for (const [id, tracks] of Object.entries({ ...ELEMENT_INTROS, ...ELEMENT_OUTROS })) {
    for (const t of tracks) assert.ok(props.has(t.prop), `${id} uses unknown prop ${t.prop}`);
  }
  for (const [id, tracks] of Object.entries(ELEMENT_LOOPS)) {
    for (const t of tracks) {
      assert.ok(props.has(t.prop), `${id} uses unknown prop ${t.prop}`);
      assert.ok(t.periodMs > 0, `${id} has a non-positive period`);
    }
  }
});

test("spin-in turns a full circle and lands square", () => {
  const start = sampleElementAnim({ intro: "spin-in" }, { elapsedMs: 0, remainingMs: null });
  const deg = Number(start.transform.match(/rotate\((-?[\d.]+)deg\)/)?.[1] ?? 0);
  assert.ok(deg <= -300, `starts near -360deg, got ${start.transform}`);
  const done = sampleElementAnim({ intro: "spin-in" }, { elapsedMs: 900, remainingMs: null });
  assert.equal(done.transform, "none", "settles to identity");
});

test("orbit traces a circle: x and y peak a quarter period apart", () => {
  const at = (ms: number) => {
    const m = sampleElementAnim({ loop: "orbit" }, { elapsedMs: ms, remainingMs: null }).transform;
    const p = m.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
    return { x: Number(p?.[1] ?? 0), y: Number(p?.[2] ?? 0) };
  };
  const period = 4200;
  const t0 = at(0);
  assert.ok(Math.abs(t0.x) < 0.1 && Math.abs(t0.y - 8) < 0.1, "starts at the top of the circle");
  const q = at(period / 4);
  assert.ok(Math.abs(q.x - 8) < 0.1 && Math.abs(q.y) < 0.1, "quarter turn later, x leads");
  // A circle keeps a constant radius.
  for (const ms of [0, 500, 1400, 2600, 3900]) {
    const p = at(ms);
    assert.ok(Math.abs(Math.hypot(p.x, p.y) - 8) < 0.2, `radius holds at ${ms}ms`);
  }
});

test("slow-zoom ramps once and holds instead of oscillating", () => {
  const scaleAt = (ms: number) => {
    const t = sampleElementAnim({ loop: "slow-zoom" }, { elapsedMs: ms, remainingMs: null }).transform;
    return Number(t.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
  };
  assert.equal(scaleAt(0), 1, "starts at rest");
  const mid = scaleAt(6000);
  assert.ok(mid > 1.06 && mid < 1.08, `half way, got ${mid}`);
  const end = scaleAt(12000);
  assert.ok(Math.abs(end - 1.14) < 0.005, `full ramp, got ${end}`);
  // The distinguishing property: it never comes back down.
  assert.equal(scaleAt(60000), end, "holds past the period rather than looping");
});

test("intensity scales travel, never the destination", () => {
  const yAt = (spec: Parameters<typeof sampleElementAnim>[0]) => {
    const t = sampleElementAnim(spec, { elapsedMs: 0, remainingMs: null }).transform;
    return Number(t.match(/translate\(0px, (-?[\d.]+)px\)/)?.[1] ?? 0);
  };
  const base = yAt({ intro: "slide-up" });
  assert.ok(Math.abs(base - 26) < 0.5, `preset offset, got ${base}`);
  assert.ok(Math.abs(yAt({ intro: "slide-up", intensity: 2 }) - 52) < 0.5, "doubled");
  assert.ok(Math.abs(yAt({ intro: "slide-up", intensity: 0 })) < 0.01, "zero = no motion");

  // Scale grows outward from its destination rather than collapsing to zero.
  const s = sampleElementAnim({ intro: "pop", intensity: 2 }, { elapsedMs: 0, remainingMs: null });
  const scale = Number(s.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
  assert.ok(Math.abs(scale - 0.2) < 0.01, `1 + (0.6-1)*2 = 0.2, got ${scale}`);

  // Opacity is exempt — a fade still starts from fully transparent.
  const o = sampleElementAnim({ intro: "fade", intensity: 3 }, { elapsedMs: 0, remainingMs: null });
  assert.ok(o.opacity <= 0.02, "fade still starts at 0");
});

test("intensity does not mutate the shared preset arrays", () => {
  const before = JSON.stringify(ELEMENT_INTROS["slide-up"]);
  sampleElementAnim({ intro: "slide-up", intensity: 3, ease: "linear" }, { elapsedMs: 10, remainingMs: null });
  assert.equal(JSON.stringify(ELEMENT_INTROS["slide-up"]), before, "presets are constants");
});

test("delay holds the element at its intro start", () => {
  const spec = { intro: "fade", delayMs: 500 };
  assert.ok(sampleElementAnim(spec, { elapsedMs: 300, remainingMs: null }).opacity <= 0.02, "still waiting");
  assert.ok(
    sampleElementAnim(spec, { elapsedMs: 900, remainingMs: null }).opacity === 1,
    "played once the delay elapsed",
  );
});

test("duration override changes the intro tween length", () => {
  const fast = sampleElementAnim({ intro: "fade", introMs: 100 }, { elapsedMs: 100, remainingMs: null });
  assert.equal(fast.opacity, 1, "a 100ms fade is done at 100ms");
  const slow = sampleElementAnim({ intro: "fade", introMs: 2000 }, { elapsedMs: 100, remainingMs: null });
  assert.ok(slow.opacity < 0.3, "a 2s fade has barely started");
});

test("loopSpeed rescales the period without changing amplitude", () => {
  const yAt = (ms: number, loopSpeed?: number) => {
    const t = sampleElementAnim({ loop: "float", loopSpeed }, { elapsedMs: ms, remainingMs: null }).transform;
    return Number(t.match(/translate\(0px, (-?[\d.]+)px\)/)?.[1] ?? 0);
  };
  // At 2x, the quarter-period peak arrives at half the time — same 6px height.
  assert.ok(Math.abs(yAt(650) - 6) < 0.5, "1x peaks at 650ms");
  assert.ok(Math.abs(yAt(325, 2) - 6) < 0.5, "2x peaks at 325ms, same amplitude");
});

test("ease override replaces the preset easing and drops its spring", () => {
  // slide-up is a spring by default and overshoots; linear cannot.
  const linear = sampleElementAnim(
    { intro: "slide-up", ease: "linear", introMs: 1000 },
    { elapsedMs: 500, remainingMs: null },
  );
  const y = Number(linear.transform.match(/translate\(0px, (-?[\d.]+)px\)/)?.[1] ?? 0);
  assert.ok(Math.abs(y - 13) < 0.6, `linear is exactly half way at half time, got ${y}`);
});

test("keyframes interpolate per property and hold at the edges", () => {
  const spec = {
    keyframes: [
      { atMs: 0, x: 0, opacity: 1 },
      { atMs: 1000, x: 100, ease: "linear" as const },
      { atMs: 2000, opacity: 0, ease: "linear" as const },
    ],
  };
  const at = (ms: number) => sampleElementAnim(spec, { elapsedMs: ms, remainingMs: null });

  const half = at(500);
  assert.match(half.transform, /translate\(50px, 0px\)/, "x half way to its 1000ms keyframe");
  // Opacity spans 0 -> 2000 and is a quarter of the way through, unaffected by
  // the 1000ms keyframe in between that only sets x.
  assert.equal(half.opacity, 0.75, "opacity interpolates across the x keyframe");

  const after = at(5000);
  assert.match(after.transform, /translate\(100px, 0px\)/, "x holds its last value");
  assert.equal(after.opacity, 0, "opacity holds its last value");

  // x is untouched by the 2000ms opacity-only keyframe — that is the point of
  // interpolating each property across only the keyframes that set it.
  assert.match(at(1500).transform, /translate\(100px, 0px\)/);
});

test("keyframes layer on top of a preset rather than replacing it", () => {
  const withKf = sampleElementAnim(
    { loop: "float", keyframes: [{ atMs: 0, y: 100 }] },
    { elapsedMs: 650, remainingMs: null },
  );
  const y = Number(withKf.transform.match(/translate\(0px, (-?[\d.]+)px\)/)?.[1] ?? 0);
  assert.ok(Math.abs(y - 106) < 0.5, `float's +6 adds to the keyframe's 100, got ${y}`);
});

test("motion overrides round-trip through serialize / parse", () => {
  const spec = {
    intro: "bounce-in",
    loop: "orbit",
    outro: "spin-out",
    intensity: 1.5,
    loopSpeed: 2,
    delayMs: 200,
    introMs: 400,
    ease: "inOut" as const,
    keyframes: [{ atMs: 0, x: 10 }],
  };
  const json = serializeElementAnim(spec);
  assert.ok(json);
  assert.deepEqual(parseElementAnim(json), spec);
});

test("serializeElementAnim omits override defaults", () => {
  assert.equal(serializeElementAnim({ intensity: 1, loopSpeed: 1, delayMs: 0 }), null);
  assert.equal(serializeElementAnim({ intro: "pop", intensity: 1 }), '{"intro":"pop"}');
  // Keyframes alone are enough to make an element animated.
  assert.equal(serializeElementAnim({ keyframes: [{ atMs: 0, x: 5 }] }), '{"keyframes":[{"atMs":0,"x":5}]}');
});

test("parseElementAnim rejects hostile keyframe payloads", () => {
  const bad = parseElementAnim(
    '{"keyframes":[{"atMs":0,"x":null},{"atMs":"x","y":1},{"atMs":1,"scale":1e999},{"atMs":2},{"atMs":3,"x":1}]}',
  );
  // Only the last entry carries a usable property; the rest are dropped.
  assert.deepEqual(bad.keyframes, [{ atMs: 3, x: 1 }]);
  assert.deepEqual(parseElementAnim('{"keyframes":"nope"}'), {});
  // Out-of-range overrides clamp rather than throwing.
  assert.equal(parseElementAnim('{"intensity":999}').intensity, 4);
  assert.equal(parseElementAnim('{"loopSpeed":-5}').loopSpeed, 0.1);
});

test("keyframes are stored sorted so sampling can scan in one pass", () => {
  const spec = parseElementAnim('{"keyframes":[{"atMs":900,"x":9},{"atMs":100,"x":1},{"atMs":500,"x":5}]}');
  assert.deepEqual(
    spec.keyframes?.map((k) => k.atMs),
    [100, 500, 900],
  );
});

test("serializeElementAnim carries loop, parse round-trips it", () => {
  assert.equal(serializeElementAnim({ loop: "none" }), null);
  assert.equal(serializeElementAnim({ loop: "bogus" }), null);
  assert.equal(serializeElementAnim({ loop: "float" }), '{"loop":"float"}');
  assert.deepEqual(parseElementAnim('{"intro":"pop","loop":"pulse"}'), { intro: "pop", loop: "pulse" });
});

test("a loop oscillates around identity and never settles", () => {
  const spec = { loop: "float" }; // translateY, amp 6, period 2600
  const atZero = sampleElementAnim(spec, { elapsedMs: 0, remainingMs: null });
  assert.equal(atZero.transform, "none", "sin(0) = 0");
  const quarter = sampleElementAnim(spec, { elapsedMs: 650, remainingMs: null }); // period/4 -> peak
  const m = quarter.transform.match(/translate\(0px, (-?[\d.]+)px\)/);
  assert.ok(m && Math.abs(Number(m[1]) - 6) < 0.5, `near +6px, got ${quarter.transform}`);
  const half = sampleElementAnim(spec, { elapsedMs: 1300, remainingMs: null });
  assert.match(half.transform, /translate\(0px, -?0(\.\d+)?px\)|none/); // back through 0
});

test("loop composes with an intro without cancelling it", () => {
  const spec = { intro: "fade", loop: "breathe" };
  const early = sampleElementAnim(spec, { elapsedMs: 0, remainingMs: null });
  assert.ok(early.opacity <= 0.02, "intro still starts from 0");
  const later = sampleElementAnim(spec, { elapsedMs: 5000, remainingMs: null });
  assert.ok(later.opacity <= 1 && later.opacity > 0.6, "breathing dip, never brighter than 1");
});

test("no animation -> identity at all times", () => {
  const a = sampleElementAnim({}, { elapsedMs: 0, remainingMs: 0 });
  assert.equal(a.transform, "none");
  assert.equal(a.opacity, 1);
  assert.equal(a.filter, undefined);
});

test("intro fade ramps opacity from 0 to 1", () => {
  const start = sampleElementAnim({ intro: "fade" }, { elapsedMs: 0, remainingMs: null });
  assert.ok(start.opacity <= 0.02);
  const mid = sampleElementAnim({ intro: "fade" }, { elapsedMs: 125, remainingMs: null });
  assert.ok(mid.opacity > 0.3 && mid.opacity < 0.95);
  const done = sampleElementAnim({ intro: "fade" }, { elapsedMs: 400, remainingMs: null });
  assert.equal(done.opacity, 1);
});

test("intro slide-up starts offset and settles near 0", () => {
  const start = sampleElementAnim({ intro: "slide-up" }, { elapsedMs: 0, remainingMs: null });
  assert.match(start.transform, /translate\(0px, 2[0-9]/); // ~26px down
  const settled = sampleElementAnim({ intro: "slide-up" }, { elapsedMs: 1200, remainingMs: null });
  const m = settled.transform.match(/translate\(0px, (-?[\d.]+)px\)/);
  const y = m ? Number(m[1]) : 0;
  assert.ok(Math.abs(y) < 4, `settles near 0, got ${settled.transform}`);
});

test("outro only fires inside its window before the end", () => {
  const early = sampleElementAnim({ outro: "fade" }, { elapsedMs: 5000, remainingMs: 2000 });
  assert.equal(early.opacity, 1, "far from the end -> untouched");
  const leaving = sampleElementAnim({ outro: "fade" }, { elapsedMs: 5000, remainingMs: 0 });
  assert.ok(leaving.opacity <= 0.05, "at the end -> faded out");
});

test("intro and outro compose without fighting", () => {
  // settled intro (opacity 1) + outro partway through (opacity < 1)
  const spec = { intro: "fade", outro: "fade" };
  const leaving = sampleElementAnim(spec, { elapsedMs: 4000, remainingMs: 100 });
  assert.ok(leaving.opacity > 0.2 && leaving.opacity < 0.9);
  // a null remaining (runs to clip end) means no outro
  const noEnd = sampleElementAnim(spec, { elapsedMs: 4000, remainingMs: null });
  assert.equal(noEnd.opacity, 1);
});
