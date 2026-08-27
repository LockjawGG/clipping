import test from "node:test";
import assert from "node:assert/strict";

import { isAnimatedPreset, remotionPreset, CAPTION_ANIMATIONS } from "../src/lib/captions/presets.ts";

test("isAnimatedPreset: NONE and nullish are static, everything else is animated", () => {
  assert.equal(isAnimatedPreset("NONE"), false);
  assert.equal(isAnimatedPreset(null), false);
  assert.equal(isAnimatedPreset(undefined), false);
  for (const a of CAPTION_ANIMATIONS) {
    assert.equal(isAnimatedPreset(a), a !== "NONE", a);
  }
});

test("remotionPreset maps the enum to the composition's preset string", () => {
  assert.equal(remotionPreset("POP"), "pop");
  assert.equal(remotionPreset("SCALE"), "scale");
  assert.equal(remotionPreset("BOUNCE"), "bounce");
  assert.equal(remotionPreset("FADE"), "fade");
  assert.equal(remotionPreset("KARAOKE"), "karaoke");
  assert.equal(remotionPreset("WORD_BY_WORD"), "word-by-word");
  assert.equal(remotionPreset("anything-else"), "word-by-word");
});
