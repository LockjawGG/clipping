import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTextStyle,
  textStyleToCss,
  textStyleFromParts,
  parseStylePartial,
  serializeStylePartial,
  styleNeedsRemotion,
  captionNeedsRemotion,
  DEFAULT_TEXT_STYLE,
  type TextStyle,
} from "../src/lib/captions/text-style.ts";
import { parseRich, serializeRich } from "../src/lib/captions/rich-extras.ts";
import {
  applyWordRules,
  isEmphasis,
  wordEffectCss,
  karaokeRules,
  emphasisRules,
  triggerMatches,
  parseWordRules,
  serializeWordRules,
} from "../src/lib/captions/word-rules.ts";
import {
  CAPTION_TEMPLATES,
  CAPTION_TEMPLATE_CATEGORIES,
  templatesByCategory,
  findTemplate,
} from "../src/lib/captions/preset-library.ts";

// ---------- text-style ----------

test("resolveTextStyle fills defaults and takes fill/layers wholesale", () => {
  const s = resolveTextStyle({ fontSizePx: 90, layers: [{ kind: "glow" }] });
  assert.equal(s.fontSizePx, 90);
  assert.equal(s.lineHeight, DEFAULT_TEXT_STYLE.lineHeight);
  assert.equal(s.fill.kind, "solid");
  assert.deepEqual(s.layers, [{ kind: "glow" }]);
  assert.deepEqual(resolveTextStyle(null), DEFAULT_TEXT_STYLE);
});

test("textStyleToCss: solid fill uses textColor, no panel by default", () => {
  const { text, panel } = textStyleToCss(resolveTextStyle({ textColor: "#FF0000" }));
  assert.equal(text.color, "#FF0000");
  assert.equal(panel, null);
  assert.match(String(text.textShadow), /rgba\(0,0,0/); // default readability shadow
});

test("textStyleToCss: gradient fill clips background to text", () => {
  const { text } = textStyleToCss(
    resolveTextStyle({ fill: { kind: "linear-gradient", stops: ["#fff", "#00f"], angleDeg: 90 } }),
  );
  assert.match(String(text.backgroundImage), /linear-gradient\(90deg, #fff, #00f\)/);
  assert.equal(text.backgroundClip, "text");
  assert.equal(text.WebkitBackgroundClip, "text");
  assert.equal(text.color, "transparent");
});

test("textStyleToCss: outline layer overrides the legacy scalar outline", () => {
  const { text } = textStyleToCss(
    resolveTextStyle({
      outlineWidthPx: 4,
      outlineColor: "#000000",
      layers: [{ kind: "outline", color: "#00E5FF", size: 3 }],
    }),
  );
  assert.equal(text.WebkitTextStroke, "3px #00E5FF");
});

test("textStyleToCss: neon layer produces a stacked shadow, scaled for preview", () => {
  const style = resolveTextStyle({ layers: [{ kind: "neon", color: "#00E5FF", size: 10 }] });
  const full = textStyleToCss(style);
  const half = textStyleToCss(style, { scale: 0.5 });
  const fullShadows = String(full.text.textShadow).split("),");
  assert.equal(fullShadows.length, 3, "three glow rings");
  // preview scaling halves the blur radii
  assert.match(String(half.text.textShadow), /0 0 5px/);
  assert.match(String(full.text.textShadow), /0 0 10px/);
});

test("textStyleToCss: glass makes a frosted panel", () => {
  const { panel } = textStyleToCss(resolveTextStyle({ glass: true }));
  assert.ok(panel);
  assert.match(String(panel!.backdropFilter), /blur/);
});

test("textStyleToCss: uppercase legacy flag maps to textTransform", () => {
  assert.equal(textStyleToCss(resolveTextStyle({ uppercase: true })).text.textTransform, "uppercase");
  assert.equal(
    textStyleToCss(resolveTextStyle({ textTransform: "capitalize", uppercase: true })).text.textTransform,
    "capitalize",
  );
});

test("styleNeedsRemotion: cheap styles burn with ffmpeg, rich ones need Remotion", () => {
  assert.equal(styleNeedsRemotion(null), false);
  assert.equal(styleNeedsRemotion({ outlineWidthPx: 12 }), false);
  assert.equal(styleNeedsRemotion({ layers: [{ kind: "outline" }, { kind: "shadow-hard" }] }), false);
  assert.equal(styleNeedsRemotion({ layers: [{ kind: "glow" }] }), true);
  assert.equal(styleNeedsRemotion({ glass: true }), true);
  assert.equal(styleNeedsRemotion({ fill: { kind: "linear-gradient", stops: ["#a", "#b"] } }), true);
});

test("captionNeedsRemotion ORs the animation and style gates", () => {
  assert.equal(captionNeedsRemotion("NONE", null), false);
  assert.equal(captionNeedsRemotion("POP", null), true);
  assert.equal(captionNeedsRemotion("NONE", { layers: [{ kind: "neon" }] }), true);
});

// ---------- word-rules ----------

test("isEmphasis: loud words, or low-confidence loud-ish words", () => {
  assert.equal(isEmphasis({ spoken: true, active: false, loudness: 0.8 }), true);
  assert.equal(isEmphasis({ spoken: true, active: false, loudness: 0.4 }), false);
  assert.equal(isEmphasis({ spoken: true, active: false, loudness: 0.55, confidence: 0.3 }), true);
  assert.equal(isEmphasis({ spoken: false, active: false, loudness: 0.9 }), false);
});

test("triggerMatches covers each trigger", () => {
  const ctx = { spoken: true, active: false, loudness: 0.9 };
  assert.equal(triggerMatches("always", ctx), true);
  assert.equal(triggerMatches("spoken", ctx), true);
  assert.equal(triggerMatches("active", ctx), false);
  assert.equal(triggerMatches("emphasis", ctx), true);
});

test("applyWordRules folds matching rules, later rule wins per field", () => {
  const rules = [
    { trigger: "spoken" as const, effect: { color: "#fff" } },
    { trigger: "emphasis" as const, effect: { color: "#f00", scale: 1.2 } },
  ];
  assert.deepEqual(applyWordRules(rules, { spoken: true, active: false, loudness: 0.1 }), {
    color: "#fff",
  });
  assert.deepEqual(applyWordRules(rules, { spoken: true, active: false, loudness: 0.9 }), {
    color: "#f00",
    scale: 1.2,
  });
  assert.deepEqual(applyWordRules(null, { spoken: true, active: true }), {});
});

test("wordEffectCss: scale -> em, bold -> 800, background -> boxed", () => {
  assert.deepEqual(wordEffectCss({ scale: 1 }), {}); // 1x is a no-op
  assert.equal(wordEffectCss({ scale: 1.2 }).fontSize, "1.2em");
  assert.equal(wordEffectCss({ bold: true }).fontWeight, 800);
  const boxed = wordEffectCss({ background: "#7C3AED" });
  assert.equal(boxed.background, "#7C3AED");
  assert.ok("padding" in boxed && "borderRadius" in boxed);
});

test("ready-made rule sets", () => {
  assert.deepEqual(karaokeRules("#0f0"), [{ trigger: "spoken", effect: { color: "#0f0" } }]);
  assert.equal(emphasisRules("#111")[0].trigger, "emphasis");
});

test("serializeWordRules prunes undefined fields, drops empty rules, round-trips", () => {
  assert.equal(serializeWordRules([]), null);
  assert.equal(
    serializeWordRules([{ trigger: "active", effect: { bold: undefined, color: undefined } }]),
    null,
    "an all-undefined effect is not a rule",
  );
  const json = serializeWordRules([
    { trigger: "active", effect: { color: "#FFE600", scale: undefined } },
    { trigger: "emphasis", effect: { bold: true } },
  ]);
  assert.equal(json, '[{"trigger":"active","effect":{"color":"#FFE600"}},{"trigger":"emphasis","effect":{"bold":true}}]');
  const back = parseWordRules(json);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], { trigger: "active", effect: { color: "#FFE600" } });
});

// ---------- preset-library ----------

test("every template is well-formed and category-consistent", () => {
  const cats = new Set(CAPTION_TEMPLATE_CATEGORIES.map((c) => c.id));
  const ids = new Set<string>();
  for (const t of CAPTION_TEMPLATES) {
    assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
    ids.add(t.id);
    assert.ok(cats.has(t.category), `${t.id} has unknown category ${t.category}`);
    assert.ok(t.name.length > 0);
    assert.ok(typeof t.animation === "string");
    // a partial style must be resolvable and emit CSS without throwing
    const css = textStyleToCss(resolveTextStyle(t.style as Partial<TextStyle>));
    assert.ok(css.text.fontFamily);
  }
});

test("each category has at least three templates", () => {
  for (const c of CAPTION_TEMPLATE_CATEGORIES) {
    assert.ok(templatesByCategory(c.id).length >= 3, `${c.id} is thin`);
  }
});

test("findTemplate round-trips and gradient templates need Remotion", () => {
  const gold = findTemplate("gradient-gold");
  assert.ok(gold);
  assert.equal(styleNeedsRemotion(gold!.style), true);
  assert.equal(findTemplate("nope"), undefined);
});

// ---------- rich-extras (advanced style editor) ----------

test("parseRich tolerates null / garbage / non-object JSON", () => {
  assert.deepEqual(parseRich(null), {});
  assert.deepEqual(parseRich("not json"), {});
  assert.deepEqual(parseRich("[1,2,3]"), {});
  assert.deepEqual(parseRich('{"glass":true}'), { glass: true });
});

test("serializeRich drops defaults so a plain style stays null", () => {
  assert.equal(serializeRich({}), null);
  assert.equal(
    serializeRich({
      letterSpacingEm: 0,
      lineHeight: 1.15,
      textTransform: "none",
      fill: { kind: "solid" },
      layers: [],
      glass: false,
    }),
    null,
  );
  assert.equal(serializeRich({ letterSpacingEm: 0.2 }), '{"letterSpacingEm":0.2}');
});

test("serializeStylePartial (full-style blob for text elements) drops defaults", () => {
  assert.equal(serializeStylePartial({}), null);
  assert.equal(serializeStylePartial({ fontFamily: "Inter", fontWeight: 700 }), null, "all defaults");
  assert.equal(
    serializeStylePartial({ fontFamily: "Impact", fontSizePx: 120 }),
    '{"fontFamily":"Impact","fontSizePx":120}',
  );
  const withRich = serializeStylePartial({
    textColor: "#FF0000",
    fill: { kind: "linear-gradient", stops: ["#a", "#b"] },
    layers: [{ kind: "glow" }],
  });
  const back = parseStylePartial(withRich);
  assert.equal(back.textColor, "#FF0000");
  assert.equal(back.fill?.kind, "linear-gradient");
  assert.equal(back.layers?.length, 1);
});

test("parseStylePartial tolerates null / garbage", () => {
  assert.deepEqual(parseStylePartial(null), {});
  assert.deepEqual(parseStylePartial("nope"), {});
  assert.deepEqual(parseStylePartial("[1]"), {});
});

test("serializeRich keeps gradient / layers / glass, and textStyleFromParts consumes it", () => {
  const json = serializeRich({
    textTransform: "uppercase",
    fill: { kind: "linear-gradient", stops: ["#fff", "#00f"], angleDeg: 120 },
    layers: [{ kind: "neon", color: "#00E5FF", size: 8 }],
    glass: true,
  });
  assert.ok(json);
  const back = parseRich(json);
  assert.equal(back.glass, true);
  assert.equal(back.fill?.kind, "linear-gradient");
  assert.equal(back.layers?.[0].kind, "neon");

  const resolved = textStyleFromParts({ fontSizePx: 60 }, json);
  assert.equal(resolved.fontSizePx, 60, "scalar base preserved");
  assert.equal(resolved.textTransform, "uppercase");
  assert.equal(resolved.layers[0].kind, "neon");
  assert.equal(styleNeedsRemotion(resolved), true);
});
