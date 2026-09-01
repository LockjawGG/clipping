import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPTION_TEMPLATES,
  CAPTION_TEMPLATE_PACKS,
  templatesByPack,
  type CaptionTemplatePack,
} from "../src/lib/captions/preset-library.ts";

const EXPECTED_PACK_ORDER: CaptionTemplatePack[] = [
  "podcast",
  "shorts",
  "gaming",
  "film",
  "lifestyle",
  "hype",
];

test("every template declares a pack that exists in the registry", () => {
  const packIds = new Set(CAPTION_TEMPLATE_PACKS.map((p) => p.id));
  for (const t of CAPTION_TEMPLATES) {
    assert.ok(packIds.has(t.pack), `${t.id} has unknown pack ${t.pack}`);
  }
});

test("no pack is empty", () => {
  for (const p of CAPTION_TEMPLATE_PACKS) {
    assert.ok(templatesByPack(p.id).length > 0, `pack ${p.id} is empty`);
  }
});

test("the pack registry has no duplicate ids", () => {
  const ids = CAPTION_TEMPLATE_PACKS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate pack id in registry");
});

test("pack registry order matches the decided display order exactly", () => {
  assert.deepEqual(
    CAPTION_TEMPLATE_PACKS.map((p) => p.id),
    EXPECTED_PACK_ORDER,
  );
});

test("every pack has between 6 and 12 templates", () => {
  for (const p of CAPTION_TEMPLATE_PACKS) {
    const count = templatesByPack(p.id).length;
    assert.ok(count >= 6, `pack ${p.id} has only ${count} templates (min 6)`);
    assert.ok(count <= 12, `pack ${p.id} has ${count} templates (max 12)`);
  }
});
