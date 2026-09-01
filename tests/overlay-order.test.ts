import test from "node:test";
import assert from "node:assert/strict";

import { compareZOrder, orderOverlayLayers, type ZOrdered } from "../src/lib/captions/overlay-order.ts";

interface Layer extends ZOrdered {
  kind: "text" | "image";
}

const layer = (id: string, kind: "text" | "image", zIndex: number): Layer => ({ id, kind, zIndex });

test("orderOverlayLayers interleaves text and image overlays by zIndex", () => {
  // Genuine cross-kind interleaving: an image and a text layer alternate, and
  // the merged/sorted list must reproduce that exact interleaving rather than
  // grouping every image before every text (or vice versa).
  const image1 = layer("img1", "image", 1);
  const text1 = layer("txt1", "text", 2);
  const image2 = layer("img2", "image", 3);
  const text2 = layer("txt2", "text", 4);

  // Fed in shuffled / kind-grouped order, as the old split-array code would
  // have produced (all images, then all text).
  const out = orderOverlayLayers([image2, image1, text2, text1]);

  assert.deepEqual(
    out.map((o) => o.id),
    ["img1", "txt1", "img2", "txt2"],
  );
  assert.deepEqual(
    out.map((o) => o.kind),
    ["image", "text", "image", "text"],
  );
});

test("orderOverlayLayers tiebreaks equal zIndex by id, independent of input order", () => {
  const a = layer("b-overlay", "text", 5);
  const b = layer("a-overlay", "image", 5);
  const c = layer("c-overlay", "text", 5);

  // Two different input orderings of the same equal-zIndex set must produce
  // the same output order — the result must not depend on array position.
  const out1 = orderOverlayLayers([a, b, c]);
  const out2 = orderOverlayLayers([c, a, b]);

  assert.deepEqual(out1.map((o) => o.id), ["a-overlay", "b-overlay", "c-overlay"]);
  assert.deepEqual(out2.map((o) => o.id), ["a-overlay", "b-overlay", "c-overlay"]);
});

test("compareZOrder sorts by zIndex first, id only breaks ties", () => {
  // A lexicographically-later id at a lower zIndex still sorts first.
  const low = layer("z-late-id", "image", 0);
  const high = layer("a-early-id", "text", 1);
  assert.equal(compareZOrder(low, high) < 0, true);
  assert.equal(compareZOrder(high, low) > 0, true);
});

test("orderOverlayLayers does not mutate its input array", () => {
  const input = [layer("z2", "text", 2), layer("z1", "image", 1)];
  const copy = [...input];
  orderOverlayLayers(input);
  assert.deepEqual(input, copy);
});
