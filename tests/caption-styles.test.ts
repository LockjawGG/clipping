import test from "node:test";
import assert from "node:assert/strict";

import type { CaptionStyleServiceDeps } from "../src/lib/api/caption-styles.ts";
import {
  applyWordStyles,
  applyWordStylesSchema,
  clearClipWordStyles,
  isResetPatch,
  listClipWordStyles,
  wordStyleSchema,
} from "../src/lib/api/caption-styles.ts";
import { ApiError } from "../src/lib/api/http.ts";

interface Row {
  id: string;
  clipId: string;
  wordId: string;
  color: string | null;
  bold: boolean | null;
  italic: boolean | null;
  sizeScale: number | null;
}

function makeDeps(over: Partial<CaptionStyleServiceDeps> = {}) {
  const rows = new Map<string, Row>(); // key: `${clipId}:${wordId}`
  let seq = 0;
  const key = (c: string, w: string) => `${c}:${w}`;
  const db: CaptionStyleServiceDeps["db"] = {
    clip: {
      findUnique: async ({ where }) =>
        where.id === "c1" ? ({ id: "c1", video: { projectId: "p1" } } as never) : null,
    },
    captionWordStyle: {
      findMany: async ({ where }) =>
        [...rows.values()].filter((r) => r.clipId === where.clipId) as never,
      findUnique: async ({ where }) =>
        (rows.get(key(where.clipId_wordId.clipId, where.clipId_wordId.wordId)) ?? null) as never,
      upsert: async ({ where, create, update }) => {
        const k = key(where.clipId_wordId.clipId, where.clipId_wordId.wordId);
        const existing = rows.get(k);
        const row = existing
          ? ({ ...existing, ...update } as Row)
          : ({ id: `s${++seq}`, ...(create as object) } as Row);
        rows.set(k, row);
        return row as never;
      },
      deleteMany: async ({ where }) => {
        for (const [k, r] of rows) {
          if (r.clipId !== where.clipId) continue;
          if (where.wordId && !where.wordId.in.includes(r.wordId)) continue;
          rows.delete(k);
        }
        return { count: 0 };
      },
    },
  };
  const deps: CaptionStyleServiceDeps = {
    db,
    assertProjectOwned: async (p) => {
      if (p !== "p1") throw new ApiError(404, "not found");
    },
    ...over,
  };
  return { deps, rows };
}

// --- schema ---------------------------------------------------------------

test("wordStyleSchema validates colour and size bounds", () => {
  assert.deepEqual(wordStyleSchema.parse({ color: "#FFE600" }), { color: "#FFE600" });
  assert.deepEqual(wordStyleSchema.parse({ color: null, bold: true }), { color: null, bold: true });
  assert.throws(() => wordStyleSchema.parse({ color: "yellow" }));
  assert.throws(() => wordStyleSchema.parse({ color: "#FFF" }));
  assert.throws(() => wordStyleSchema.parse({ sizeScale: 10 }));
  assert.throws(() => wordStyleSchema.parse({ sizeScale: 0.1 }));
});

test("applyWordStylesSchema caps the word list", () => {
  assert.throws(() => applyWordStylesSchema.parse({ wordIds: [], style: { bold: true } }));
  assert.throws(() =>
    applyWordStylesSchema.parse({ wordIds: Array(501).fill("w"), style: { bold: true } }),
  );
});

test("isResetPatch is true only when every attribute is null/absent", () => {
  assert.equal(isResetPatch({}), true);
  assert.equal(isResetPatch({ color: null, bold: null }), true);
  assert.equal(isResetPatch({ color: "#000000" }), false);
  assert.equal(isResetPatch({ bold: false }), false);
});

// --- apply / list -------------------------------------------------------

test("applyWordStyles creates rows and merges successive patches", async () => {
  const { deps, rows } = makeDeps();
  await applyWordStyles(deps, "c1", { wordIds: ["w1", "w2"], style: { color: "#FFE600" } });
  await applyWordStyles(deps, "c1", { wordIds: ["w1"], style: { bold: true } });

  const map = await listClipWordStyles(deps, "c1");
  assert.deepEqual(map.w1, { color: "#FFE600", bold: true, italic: null, sizeScale: null });
  assert.deepEqual(map.w2, { color: "#FFE600", bold: null, italic: null, sizeScale: null });
  assert.equal(rows.size, 2);
});

test("applyWordStyles clears an attribute with null and deletes an emptied row", async () => {
  const { deps, rows } = makeDeps();
  await applyWordStyles(deps, "c1", { wordIds: ["w1"], style: { color: "#FF0000", bold: true } });
  // clear the colour -> row keeps bold
  await applyWordStyles(deps, "c1", { wordIds: ["w1"], style: { color: null } });
  assert.deepEqual((await listClipWordStyles(deps, "c1")).w1, {
    color: null,
    bold: true,
    italic: null,
    sizeScale: null,
  });
  // clear bold too -> row is now empty -> removed
  await applyWordStyles(deps, "c1", { wordIds: ["w1"], style: { bold: null } });
  assert.equal(rows.size, 0);
});

test("applyWordStyles dedupes wordIds", async () => {
  const { deps, rows } = makeDeps();
  await applyWordStyles(deps, "c1", { wordIds: ["w1", "w1", "w1"], style: { italic: true } });
  assert.equal(rows.size, 1);
});

test("applyWordStyles 404s for an unknown clip or a foreign project", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => applyWordStyles(deps, "ghost", { wordIds: ["w1"], style: { bold: true } }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  const foreign = makeDeps({ assertProjectOwned: async () => { throw new ApiError(404, "no"); } });
  await assert.rejects(
    () => applyWordStyles(foreign.deps, "c1", { wordIds: ["w1"], style: { bold: true } }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("applyWordStyles rejects a bad colour before writing", async () => {
  const { deps, rows } = makeDeps();
  await assert.rejects(() =>
    applyWordStyles(deps, "c1", { wordIds: ["w1"], style: { color: "#GGGGGG" } }),
  );
  assert.equal(rows.size, 0);
});

test("listClipWordStyles 404s for an unowned clip", async () => {
  const { deps } = makeDeps({ assertProjectOwned: async () => { throw new ApiError(404, "no"); } });
  await assert.rejects(
    () => listClipWordStyles(deps, "c1"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- clear -----------------------------------------------------------

test("clearClipWordStyles removes a subset, then all", async () => {
  const { deps, rows } = makeDeps();
  await applyWordStyles(deps, "c1", { wordIds: ["w1", "w2", "w3"], style: { color: "#FFFFFF" } });
  await clearClipWordStyles(deps, "c1", ["w2"]);
  assert.deepEqual(Object.keys(await listClipWordStyles(deps, "c1")).sort(), ["w1", "w3"]);
  await clearClipWordStyles(deps, "c1");
  assert.equal(rows.size, 0);
});
