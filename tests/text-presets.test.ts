import test from "node:test";
import assert from "node:assert/strict";

import type { TextPresetDb, TextPresetServiceDeps } from "../src/lib/api/text-presets.ts";
import {
  listTextPresets,
  createTextPreset,
  deleteTextPreset,
  createTextPresetSchema,
} from "../src/lib/api/text-presets.ts";
import { ApiError } from "../src/lib/api/http.ts";

interface Row {
  id: string;
  userId: string;
  name: string;
  kind: string;
  style: string;
  animation: string;
  wordRules: string | null;
  createdAt: Date;
}

function makeDeps(userId = "u1") {
  const rows = new Map<string, Row>([
    ["p1", { id: "p1", userId: "u1", name: "Gold title", kind: "caption", style: '{"fontFamily":"Impact"}', animation: "POP", wordRules: null, createdAt: new Date(2) }],
    ["p2", { id: "p2", userId: "u1", name: "My lower third", kind: "text", style: '{"glass":true}', animation: "NONE", wordRules: null, createdAt: new Date(1) }],
    ["pX", { id: "pX", userId: "someone-else", name: "Theirs", kind: "caption", style: "{}", animation: "NONE", wordRules: null, createdAt: new Date(3) }],
  ]);
  let seq = 0;
  const db: TextPresetDb = {
    textPreset: {
      findMany: async ({ where, orderBy }) => {
        void orderBy;
        return [...rows.values()]
          .filter((r) => r.userId === where.userId && (where.kind === undefined || r.kind === where.kind))
          .sort((a, b) => +b.createdAt - +a.createdAt);
      },
      findUnique: async ({ where }) => {
        const r = rows.get(where.id);
        return r ? { id: r.id, userId: r.userId } : null;
      },
      create: async ({ data }) => {
        const id = `new${++seq}`;
        const row: Row = {
          id,
          userId: data.userId as string,
          name: data.name as string,
          kind: data.kind as string,
          style: data.style as string,
          animation: data.animation as string,
          wordRules: (data.wordRules as string | null) ?? null,
          createdAt: new Date(100 + seq),
        };
        rows.set(id, row);
        return row;
      },
      delete: async ({ where }) => {
        rows.delete(where.id);
      },
    },
  };
  const deps: TextPresetServiceDeps = { db, userId };
  return { deps, rows };
}

test("createTextPresetSchema defaults and bounds", () => {
  assert.throws(() => createTextPresetSchema.parse({ name: "", style: "{}" }));
  assert.throws(() => createTextPresetSchema.parse({ name: "x", style: "{}", kind: "banner" }));
  const p = createTextPresetSchema.parse({ name: "  Hi  ", style: "{}" });
  assert.equal(p.name, "Hi");
  assert.equal(p.kind, "caption");
  assert.equal(p.animation, "NONE");
});

test("listTextPresets returns the user's presets, newest first, filterable by kind", async () => {
  const { deps } = makeDeps();
  const all = await listTextPresets(deps);
  assert.deepEqual(all.map((p) => p.id), ["p1", "p2"]); // newest first, no other user's
  const captions = await listTextPresets(deps, "caption");
  assert.deepEqual(captions.map((p) => p.id), ["p1"]);
  const texts = await listTextPresets(deps, "text");
  assert.deepEqual(texts.map((p) => p.id), ["p2"]);
});

test("createTextPreset stores a caption style for the user", async () => {
  const { deps, rows } = makeDeps();
  const v = await createTextPreset(deps, {
    name: "Neon",
    style: '{"layers":[{"kind":"neon"}]}',
    animation: "FADE",
  });
  assert.equal(v.name, "Neon");
  assert.equal(v.kind, "caption");
  assert.equal(rows.get(v.id)!.userId, "u1");
});

test("createTextPreset rejects a non-object style blob (422)", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => createTextPreset(deps, { name: "bad", style: "[1,2,3]" }),
    (e: unknown) => e instanceof ApiError && e.status === 422,
  );
  await assert.rejects(
    () => createTextPreset(deps, { name: "bad", style: "not json" }),
    (e: unknown) => e instanceof ApiError && e.status === 422,
  );
});

test("deleteTextPreset removes an owned preset, 404 for someone else's", async () => {
  const { deps, rows } = makeDeps();
  await deleteTextPreset(deps, "p1");
  assert.equal(rows.has("p1"), false);
  await assert.rejects(
    () => deleteTextPreset(deps, "pX"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});
