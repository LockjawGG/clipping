import test from "node:test";
import assert from "node:assert/strict";

import type { StorageProvider } from "../src/lib/providers/types.ts";
import type { OverlayServiceDeps } from "../src/lib/api/overlays.ts";
import {
  createOverlayFromAsset,
  createOverlaySchema,
  deleteOverlay,
  listClipOverlays,
  listClipOverlaysBulk,
  reorderOverlay,
  updateOverlay,
  updateOverlaySchema,
} from "../src/lib/api/overlays.ts";
import { ApiError } from "../src/lib/api/http.ts";

function fakeStorage(over: Partial<StorageProvider> = {}): StorageProvider {
  return {
    name: "fake",
    createUploadUrl: async (k) => `https://up/${k}`,
    createDownloadUrl: async (k) => `https://dl/${k}`,
    putFile: async () => {},
    getToFile: async () => {},
    delete: async () => {},
    exists: async () => true,
    ...over,
  };
}

interface Ov {
  id: string;
  clipId: string;
  kind: string;
  content: string;
  assetId: string | null;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  startMs: number | null;
  endMs: number | null;
  zIndex: number;
  hidden: boolean;
}

/** A clip 0..10_000ms long in project "p1", plus one IMAGE + one AUDIO asset. */
function makeDeps(over: Partial<OverlayServiceDeps> = {}) {
  const overlays = new Map<string, Ov>();
  let seq = 0;
  const clips: Record<string, { id: string; startMs: number; endMs: number; projectId: string }> = {
    c1: { id: "c1", startMs: 5_000, endMs: 15_000, projectId: "p1" },
  };
  const assets: Record<string, { id: string; projectId: string; kind: string; name: string; storageKey: string }> = {
    img1: { id: "img1", projectId: "p1", kind: "IMAGE", name: "logo.png", storageKey: "assets/image/a.png" },
    gif1: { id: "gif1", projectId: "p1", kind: "GIF", name: "spin.gif", storageKey: "assets/gif/b.gif" },
    snd1: { id: "snd1", projectId: "p1", kind: "AUDIO", name: "bed.mp3", storageKey: "assets/audio/c.mp3" },
    foreign: { id: "foreign", projectId: "p2", kind: "IMAGE", name: "x.png", storageKey: "assets/image/x.png" },
  };

  const db: OverlayServiceDeps["db"] = {
    overlay: {
      findMany: async ({ where }) => {
        const inClip = (id: string) =>
          typeof where.clipId === "string" ? id === where.clipId : where.clipId.in.includes(id);
        return [...overlays.values()]
          .filter((o) => inClip(o.clipId))
          .sort((a, b) => a.zIndex - b.zIndex) as never;
      },
      findUnique: async ({ where }) => (overlays.get(where.id) ?? null) as never,
      create: async ({ data }) => {
        const id = `o${++seq}`;
        const row = { id, rotation: 0, hidden: false, ...data } as Ov;
        overlays.set(id, row);
        return row as never;
      },
      update: async ({ where, data }) => {
        Object.assign(overlays.get(where.id)!, data);
        return overlays.get(where.id) as never;
      },
      delete: async ({ where }) => {
        overlays.delete(where.id);
        return {};
      },
      aggregate: async ({ where }) => {
        const zs = [...overlays.values()]
          .filter((o) => o.clipId === where.clipId)
          .map((o) => o.zIndex);
        return { _max: { zIndex: zs.length ? Math.max(...zs) : null } } as never;
      },
    },
    clip: {
      findUnique: async ({ where }) => {
        const c = clips[where.id];
        return c ? ({ id: c.id, startMs: c.startMs, endMs: c.endMs, video: { projectId: c.projectId } } as never) : null;
      },
    },
    asset: {
      findUnique: async ({ where }) => (assets[where.id] as never) ?? null,
      findMany: async ({ where }) =>
        Object.values(assets).filter((a) => where.id.in.includes(a.id)) as never,
    },
  };

  const deps: OverlayServiceDeps = {
    db,
    storage: fakeStorage(),
    assertProjectOwned: async (p) => {
      if (p !== "p1") throw new ApiError(404, "not found");
    },
    ...over,
  };
  return { deps, overlays, clips };
}

// --- schema ---------------------------------------------------------------

test("createOverlaySchema enforces bounds", () => {
  assert.throws(() => createOverlaySchema.parse({ assetId: "a", x: 1.5 }));
  assert.throws(() => createOverlaySchema.parse({ assetId: "a", scale: 0 }));
  assert.throws(() => createOverlaySchema.parse({ assetId: "a", opacity: -0.1 }));
  assert.throws(() => createOverlaySchema.parse({ x: 0.5 }), /assetId/);
  assert.deepEqual(createOverlaySchema.parse({ assetId: "a" }), { assetId: "a" });
  assert.equal(createOverlaySchema.parse({ assetId: "a", startMs: null }).startMs, null);
});

test("updateOverlaySchema rejects empty and inverted ranges", () => {
  assert.throws(() => updateOverlaySchema.parse({}), /nothing to update/);
  assert.throws(() => updateOverlaySchema.parse({ startMs: 3000, endMs: 1000 }), /after startMs/);
  assert.deepEqual(updateOverlaySchema.parse({ startMs: 1000, endMs: 3000 }), {
    startMs: 1000,
    endMs: 3000,
  });
  assert.deepEqual(updateOverlaySchema.parse({ endMs: null }), { endMs: null });
});

// --- create -------------------------------------------------------------

test("createOverlayFromAsset places an image and returns a signed URL", async () => {
  const { deps, overlays } = makeDeps();
  const v = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  assert.equal(v.assetId, "img1");
  assert.equal(v.name, "logo.png");
  assert.equal(v.url, "https://dl/assets/image/a.png");
  assert.equal(v.x, 0.5);
  assert.equal(v.y, 0.5);
  assert.equal(v.opacity, 1);
  assert.equal(v.startMs, null);
  assert.equal(v.endMs, null);
  assert.equal(v.zIndex, 1);
  assert.equal(overlays.size, 1);
});

test("createOverlayFromAsset stacks zIndex per clip", async () => {
  const { deps } = makeDeps();
  const a = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  const b = await createOverlayFromAsset(deps, "c1", { assetId: "gif1", x: 0.2, y: 0.9 });
  assert.equal(a.zIndex, 1);
  assert.equal(b.zIndex, 2);
  assert.equal(b.x, 0.2);
  assert.equal(b.y, 0.9);
});

test("createOverlayFromAsset accepts a timed window inside the clip", async () => {
  const { deps } = makeDeps();
  const v = await createOverlayFromAsset(deps, "c1", { assetId: "img1", startMs: 1000, endMs: 4000 });
  assert.equal(v.startMs, 1000);
  assert.equal(v.endMs, 4000);
});

test("createOverlayFromAsset rejects a non-visual asset (422)", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => createOverlayFromAsset(deps, "c1", { assetId: "snd1" }),
    (e: unknown) => e instanceof ApiError && e.status === 422,
  );
});

test("createOverlayFromAsset rejects an asset from another project (404)", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => createOverlayFromAsset(deps, "c1", { assetId: "foreign" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("createOverlayFromAsset 404s for an unknown clip or asset", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => createOverlayFromAsset(deps, "nope", { assetId: "img1" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  await assert.rejects(
    () => createOverlayFromAsset(deps, "c1", { assetId: "ghost" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("createOverlayFromAsset rejects a window outside the clip (422)", async () => {
  const { deps } = makeDeps(); // clip is 10_000ms long
  await assert.rejects(
    () => createOverlayFromAsset(deps, "c1", { assetId: "img1", startMs: 12_000 }),
    (e: unknown) => e instanceof ApiError && e.status === 422,
  );
  await assert.rejects(
    () => createOverlayFromAsset(deps, "c1", { assetId: "img1", startMs: 3000, endMs: 2000 }),
    (e: unknown) => e instanceof ApiError && e.status === 422,
  );
});

test("createOverlayFromAsset 404s when the caller owns nothing", async () => {
  const { deps } = makeDeps({ assertProjectOwned: async () => { throw new ApiError(404, "no"); } });
  await assert.rejects(
    () => createOverlayFromAsset(deps, "c1", { assetId: "img1" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("listClipOverlaysBulk groups by clip, resolves assets once, and fills empties", async () => {
  const { deps, overlays } = makeDeps();
  const row = (id: string, clipId: string, assetId: string | null, zIndex: number): Ov => ({
    id, clipId, kind: "IMAGE", content: id, assetId,
    x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1,
    startMs: null, endMs: null, zIndex, hidden: false,
  });
  overlays.set("o1", row("o1", "c1", "img1", 1));
  overlays.set("o2", row("o2", "c1", "gif1", 2));
  overlays.set("o3", row("o3", "c2", "img1", 1));
  overlays.set("o4", row("o4", "c2", null, 2)); // no asset -> null url/name

  let signs = 0;
  const spyStorage = fakeStorage({
    createDownloadUrl: async (k) => {
      signs++;
      return `https://dl/${k}`;
    },
  });

  const out = await listClipOverlaysBulk({ ...deps, storage: spyStorage }, ["c1", "c2", "c3"]);

  assert.deepEqual(Object.keys(out).sort(), ["c1", "c2", "c3"]);
  assert.equal(out.c3.length, 0); // asked-for clip with nothing still present
  assert.deepEqual(out.c1.map((o) => o.id), ["o1", "o2"]); // sorted by zIndex
  assert.equal(out.c1[0].url, "https://dl/assets/image/a.png");
  assert.equal(out.c2.find((o) => o.id === "o4")!.url, null);
  assert.equal(signs, 2); // two distinct storage keys (img1, gif1) signed once each
});

test("listClipOverlaysBulk short-circuits on an empty id list", async () => {
  const { deps } = makeDeps();
  assert.deepEqual(await listClipOverlaysBulk(deps, []), {});
});

// --- list -------------------------------------------------------------

test("listClipOverlays returns the stack bottom-to-top with URLs", async () => {
  const { deps } = makeDeps();
  await createOverlayFromAsset(deps, "c1", { assetId: "gif1" });
  await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  const list = await listClipOverlays(deps, "c1");
  assert.deepEqual(list.map((o) => o.name), ["spin.gif", "logo.png"]);
  assert.deepEqual(list.map((o) => o.zIndex), [1, 2]);
  assert.ok(list.every((o) => o.url?.startsWith("https://dl/")));
});

test("listClipOverlays 404s for a clip the caller does not own", async () => {
  const { deps, clips } = makeDeps();
  clips.c1.projectId = "p2";
  await assert.rejects(
    () => listClipOverlays(deps, "c1"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- update -----------------------------------------------------------

test("updateOverlay re-times and repositions", async () => {
  const { deps, overlays } = makeDeps();
  const { id } = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  const v = await updateOverlay(deps, id, { startMs: 2000, endMs: 6000, x: 0.1, opacity: 0.5 });
  assert.equal(v.startMs, 2000);
  assert.equal(v.endMs, 6000);
  assert.equal(v.x, 0.1);
  assert.equal(v.opacity, 0.5);
  assert.equal(v.y, 0.5, "untouched fields stay");
  assert.equal(overlays.get(id)!.startMs, 2000);
});

test("updateOverlay rejects an empty or inverted patch before writing", async () => {
  const { deps } = makeDeps();
  const { id } = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  await assert.rejects(() => updateOverlay(deps, id, {}));
  await assert.rejects(() => updateOverlay(deps, id, { startMs: 5000, endMs: 1000 }));
});

test("updateOverlay rejects a start past the clip end (422)", async () => {
  const { deps } = makeDeps();
  const { id } = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  await assert.rejects(
    () => updateOverlay(deps, id, { startMs: 99_000 }),
    (e: unknown) => e instanceof ApiError && e.status === 422,
  );
});

test("updateOverlay 404s for an unknown overlay and a foreign clip", async () => {
  const { deps, clips } = makeDeps();
  await assert.rejects(
    () => updateOverlay(deps, "ghost", { x: 0.5 }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  const { id } = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  clips.c1.projectId = "p2";
  await assert.rejects(
    () => updateOverlay(deps, id, { x: 0.5 }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("updateOverlay toggles the hidden flag", async () => {
  const { deps, overlays } = makeDeps();
  const { id } = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  const v = await updateOverlay(deps, id, { hidden: true });
  assert.equal(v.hidden, true);
  assert.equal(overlays.get(id)!.hidden, true);
  const back = await updateOverlay(deps, id, { hidden: false });
  assert.equal(back.hidden, false);
});

test("updateOverlaySchema accepts a lone hidden flag", () => {
  assert.deepEqual(updateOverlaySchema.parse({ hidden: true }), { hidden: true });
});

// --- reorder -------------------------------------------------------

test("reorderOverlay swaps zIndex with the neighbour in that direction", async () => {
  const { deps } = makeDeps();
  const a = await createOverlayFromAsset(deps, "c1", { assetId: "img1" }); // z=1
  const b = await createOverlayFromAsset(deps, "c1", { assetId: "gif1" }); // z=2 (top)
  assert.deepEqual([a.zIndex, b.zIndex], [1, 2]);

  // bring the bottom one up -> it takes the top slot
  const movedA = await reorderOverlay(deps, a.id, "up");
  assert.equal(movedA.zIndex, 2);
  const list = await listClipOverlays(deps, "c1");
  assert.deepEqual(
    list.map((o) => [o.name, o.zIndex]),
    [
      ["spin.gif", 1],
      ["logo.png", 2],
    ],
  );
});

test("reorderOverlay is a no-op at the edges", async () => {
  const { deps } = makeDeps();
  const a = await createOverlayFromAsset(deps, "c1", { assetId: "img1" }); // z=1 (bottom)
  await createOverlayFromAsset(deps, "c1", { assetId: "gif1" }); // z=2 (top)
  const stillBottom = await reorderOverlay(deps, a.id, "down");
  assert.equal(stillBottom.zIndex, 1);
});

test("reorderOverlay 404s for an unknown overlay or a foreign clip", async () => {
  const { deps, clips } = makeDeps();
  await assert.rejects(
    () => reorderOverlay(deps, "ghost", "up"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  const { id } = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  clips.c1.projectId = "p2";
  await assert.rejects(
    () => reorderOverlay(deps, id, "up"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

// --- delete ---------------------------------------------------------

test("deleteOverlay removes the row", async () => {
  const { deps, overlays } = makeDeps();
  const { id } = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  const res = await deleteOverlay(deps, id);
  assert.deepEqual(res, { id, deleted: true });
  assert.equal(overlays.size, 0);
});

test("deleteOverlay 404s for an unknown overlay or a foreign clip", async () => {
  const { deps, clips, overlays } = makeDeps();
  await assert.rejects(
    () => deleteOverlay(deps, "ghost"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  const { id } = await createOverlayFromAsset(deps, "c1", { assetId: "img1" });
  clips.c1.projectId = "p2";
  await assert.rejects(
    () => deleteOverlay(deps, id),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  assert.equal(overlays.size, 1, "a failed ownership check leaves the row intact");
});
