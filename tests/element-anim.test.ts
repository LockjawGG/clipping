import test from "node:test";
import assert from "node:assert/strict";

import {
  parseElementAnim,
  serializeElementAnim,
  sampleElementAnim,
  ELEMENT_INTRO_OPTIONS,
  ELEMENT_OUTRO_OPTIONS,
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
  assert.ok(ELEMENT_INTRO_OPTIONS.some((o) => o.id === "slide-up"));
  assert.ok(ELEMENT_OUTRO_OPTIONS.some((o) => o.id === "zoom-out"));
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
