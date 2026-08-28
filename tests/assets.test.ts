import test from "node:test";
import assert from "node:assert/strict";

import type { StorageProvider } from "../src/lib/providers/types.ts";
import type { AssetDb, AssetServiceDeps } from "../src/lib/api/assets.ts";
import {
  confirmAsset,
  createAssetUpload,
  deleteAsset,
  listAssets,
  updateAsset,
  updateAssetSchema,
} from "../src/lib/api/assets.ts";
import { ApiError } from "../src/lib/api/http.ts";

function fakeStorage(over: Partial<StorageProvider> = {}): StorageProvider {
  return {
    name: "fake",
    createUploadUrl: async (key) => `https://up.example/${key}`,
    createDownloadUrl: async (key) => `https://dl.example/${key}`,
    putFile: async () => {},
    getToFile: async () => {},
    delete: async () => {},
    exists: async () => true,
    ...over,
  };
}

type Row = Parameters<AssetDb["asset"]["create"]>[0]["data"] & {
  id: string;
  createdAt: Date;
  favoritedAt: Date | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sizeBytes: bigint | null;
};

function makeDeps(over: Partial<AssetServiceDeps> = {}) {
  const rows = new Map<string, Row>();
  let seq = 0;
  const db: AssetDb = {
    asset: {
      findMany: async ({ where }) =>
        [...rows.values()].filter((r) => r.projectId === where.projectId) as never,
      findUnique: async ({ where }) => (rows.get(where.id) ?? null) as never,
      create: async ({ data }) => {
        const id = `a${++seq}`;
        const row = {
          id,
          createdAt: new Date(seq),
          favoritedAt: null,
          width: null,
          height: null,
          durationMs: null,
          ...data,
        } as Row;
        rows.set(id, row);
        return row as never;
      },
      update: async ({ where, data }) => {
        Object.assign(rows.get(where.id)!, data);
        return rows.get(where.id) as never;
      },
      delete: async ({ where }) => {
        rows.delete(where.id);
        return {};
      },
    },
  };
  const deps: AssetServiceDeps = {
    db,
    storage: fakeStorage(),
    maxUploadBytes: 50_000_000,
    assertProjectOwned: async (p) => {
      if (p !== "p1") throw new ApiError(404, "not found");
    },
    ...over,
  };
  return { deps, rows };
}

const upload = {
  projectId: "p1",
  kind: "IMAGE" as const,
  name: "logo.png",
  mimeType: "image/png",
  sizeBytes: 4096,
};

test("createAssetUpload validates ownership and returns a presigned PUT", async () => {
  const { deps, rows } = makeDeps();
  const res = await createAssetUpload(deps, upload);
  assert.match(res.upload.url, /^https:\/\/up\.example\/assets\/image\//);
  assert.equal(rows.size, 1);
});

test("createAssetUpload rejects an oversize file and a foreign project", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => createAssetUpload(deps, { ...upload, sizeBytes: 99_000_000 }),
    (e: unknown) => e instanceof ApiError && e.status === 413,
  );
  await assert.rejects(
    () => createAssetUpload(deps, { ...upload, projectId: "someone-else" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("confirmAsset attaches measured dimensions", async () => {
  const { deps, rows } = makeDeps();
  const { assetId } = await createAssetUpload(deps, upload);
  const view = await confirmAsset(deps, assetId, { width: 800, height: 600 });
  assert.equal(view.width, 800);
  assert.equal(rows.get(assetId)!.width, 800);
});

test("confirmAsset 409s when the upload never landed", async () => {
  const { deps } = makeDeps({ storage: fakeStorage({ exists: async () => false }) });
  const { assetId } = await createAssetUpload(deps, upload);
  await assert.rejects(
    () => confirmAsset(deps, assetId, {}),
    (e: unknown) => e instanceof ApiError && e.status === 409,
  );
});

test("updateAsset renames and toggles favorite; listAssets returns URLs", async () => {
  const { deps } = makeDeps();
  const { assetId } = await createAssetUpload(deps, upload);
  await updateAsset(deps, assetId, { name: "brand.png", favorite: true });
  const list = await listAssets(deps, "p1");
  assert.equal(list[0].name, "brand.png");
  assert.equal(list[0].favorited, true);
  assert.match(list[0].url!, /^https:\/\/dl\.example\//);
});

test("updateAssetSchema: field rules", () => {
  // a lone kind is a valid patch
  assert.deepEqual(updateAssetSchema.parse({ kind: "SFX" }), { kind: "SFX" });
  // name + favorite + kind together
  assert.deepEqual(
    updateAssetSchema.parse({ name: "x", favorite: false, kind: "GIF" }),
    { name: "x", favorite: false, kind: "GIF" },
  );
  // empty patch is rejected
  assert.throws(() => updateAssetSchema.parse({}), /nothing to update/);
  // unknown kind is rejected
  assert.throws(() => updateAssetSchema.parse({ kind: "VIDEO" }));
  // blank name is rejected
  assert.throws(() => updateAssetSchema.parse({ name: "   " }));
});

test("updateAsset changes kind and it survives listAssets", async () => {
  const { deps, rows } = makeDeps();
  const { assetId } = await createAssetUpload(deps, {
    ...upload,
    kind: "AUDIO",
    name: "clap.wav",
    mimeType: "audio/wav",
  });
  assert.equal(rows.get(assetId)!.kind, "AUDIO");

  const view = await updateAsset(deps, assetId, { kind: "SFX" });
  assert.equal(view.kind, "SFX");
  assert.equal(view.name, "clap.wav", "kind-only patch leaves name untouched");
  assert.equal(rows.get(assetId)!.kind, "SFX");

  const list = await listAssets(deps, "p1");
  assert.equal(list[0].kind, "SFX");
});

test("updateAsset applies name, favorite and kind in one call", async () => {
  const { deps, rows } = makeDeps();
  const { assetId } = await createAssetUpload(deps, upload); // IMAGE
  const view = await updateAsset(deps, assetId, {
    name: "hero.gif",
    favorite: true,
    kind: "GIF",
  });
  assert.equal(view.name, "hero.gif");
  assert.equal(view.kind, "GIF");
  assert.equal(view.favorited, true);
  const row = rows.get(assetId)!;
  assert.equal(row.name, "hero.gif");
  assert.equal(row.kind, "GIF");
  assert.ok(row.favoritedAt instanceof Date);
});

test("updateAsset 404s for an unknown asset and a foreign project", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => updateAsset(deps, "nope", { kind: "SFX" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  // asset that exists but whose project the caller doesn't own
  const foreign = makeDeps();
  const { assetId } = await createAssetUpload(foreign.deps, upload);
  foreign.rows.get(assetId)!.projectId = "someone-else";
  await assert.rejects(
    () => updateAsset(foreign.deps, assetId, { name: "x" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("updateAsset rejects an invalid patch before touching the row", async () => {
  const { deps } = makeDeps();
  const { assetId } = await createAssetUpload(deps, upload);
  await assert.rejects(() => updateAsset(deps, assetId, {}));
  await assert.rejects(() => updateAsset(deps, assetId, { kind: "NOPE" }));
});

test("deleteAsset removes the row and the stored file", async () => {
  let deletedKey = "";
  const { deps, rows } = makeDeps({
    storage: fakeStorage({ delete: async (k) => void (deletedKey = k) }),
  });
  const { assetId } = await createAssetUpload(deps, upload);
  await deleteAsset(deps, assetId);
  assert.equal(rows.size, 0);
  assert.match(deletedKey, /^assets\/image\//);
});
