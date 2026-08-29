import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import { z } from "zod";

import type { StorageProvider } from "../providers/types.ts";
import { ApiError } from "./http.ts";

/**
 * The user's media library: images / GIFs used as overlays, and audio / SFX
 * beds. Owned by the user and shared across every project. Upload mirrors the
 * video flow — create a row + presigned PUT, the client pushes the bytes, then
 * confirms with the intrinsic dimensions it measured.
 */

const KINDS = ["IMAGE", "GIF", "AUDIO", "SFX"] as const;
export type AssetKind = (typeof KINDS)[number];

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/i;

export const createAssetSchema = z.object({
  kind: z.enum(KINDS),
  name: z.string().trim().min(1).max(300),
  mimeType: z.string().regex(/^[-\w.]+\/[-\w.+]+$/, "not a MIME type"),
  sizeBytes: z.number().int().positive(),
});

export const confirmAssetSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().positive().optional(),
});

export const updateAssetSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    favorite: z.boolean(),
    kind: z.enum(KINDS),
  })
  .partial()
  .refine(
    (v) => v.name !== undefined || v.favorite !== undefined || v.kind !== undefined,
    "nothing to update",
  );

interface AssetRow {
  id: string;
  userId: string;
  kind: string;
  name: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: bigint | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  favoritedAt: Date | null;
  createdAt: Date;
}

export interface AssetDb {
  asset: {
    findMany(args: { where: { userId: string }; orderBy?: unknown }): Promise<AssetRow[]>;
    findUnique(args: { where: { id: string } }): Promise<AssetRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<AssetRow>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<AssetRow>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

export interface AssetServiceDeps {
  db: AssetDb;
  storage: StorageProvider;
  maxUploadBytes: number;
  /** The signed-in user — owns the whole library. */
  userId: string;
}

function assetKey(kind: AssetKind, filename: string): string {
  const ext = extname(filename).toLowerCase();
  const safe = SAFE_EXT.test(ext) ? ext : "";
  return `assets/${kind.toLowerCase()}/${randomUUID()}${safe}`;
}

async function ownedAsset(deps: AssetServiceDeps, assetId: string): Promise<AssetRow> {
  const asset = await deps.db.asset.findUnique({ where: { id: assetId } });
  if (!asset || asset.userId !== deps.userId) throw new ApiError(404, "asset not found");
  return asset;
}

function toView(a: AssetRow, url: string | null) {
  return {
    id: a.id,
    kind: a.kind as AssetKind,
    name: a.name,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes === null ? null : Number(a.sizeBytes),
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    favorited: a.favoritedAt !== null,
    createdAt: a.createdAt.toISOString(),
    url,
  };
}

export async function listAssets(deps: AssetServiceDeps) {
  const rows = await deps.db.asset.findMany({
    where: { userId: deps.userId },
    orderBy: { createdAt: "desc" },
  });
  return Promise.all(
    rows.map(async (a) => toView(a, await deps.storage.createDownloadUrl(a.storageKey))),
  );
}

export async function createAssetUpload(deps: AssetServiceDeps, input: unknown) {
  const parsed = createAssetSchema.parse(input);
  if (parsed.sizeBytes > deps.maxUploadBytes) {
    throw new ApiError(413, `file is larger than the ${deps.maxUploadBytes}-byte limit`);
  }

  const storageKey = assetKey(parsed.kind, parsed.name);
  const uploadUrl = await deps.storage.createUploadUrl(storageKey, parsed.mimeType);

  const asset = await deps.db.asset.create({
    data: {
      userId: deps.userId,
      kind: parsed.kind,
      name: parsed.name.slice(0, 300),
      storageKey,
      mimeType: parsed.mimeType,
      sizeBytes: BigInt(parsed.sizeBytes),
    },
  });

  return {
    assetId: asset.id,
    upload: { url: uploadUrl, method: "PUT" as const, headers: { "content-type": parsed.mimeType } },
  };
}

export async function confirmAsset(deps: AssetServiceDeps, assetId: string, input: unknown) {
  const { width, height, durationMs } = confirmAssetSchema.parse(input);
  const asset = await ownedAsset(deps, assetId);
  if (!(await deps.storage.exists(asset.storageKey))) {
    throw new ApiError(409, "no uploaded file found for this asset");
  }
  const data: Record<string, unknown> = {};
  if (width !== undefined) data.width = width;
  if (height !== undefined) data.height = height;
  if (durationMs !== undefined) data.durationMs = durationMs;
  const updated = Object.keys(data).length
    ? await deps.db.asset.update({ where: { id: assetId }, data })
    : asset;
  return toView(updated, await deps.storage.createDownloadUrl(updated.storageKey));
}

export async function updateAsset(deps: AssetServiceDeps, assetId: string, input: unknown) {
  const patch = updateAssetSchema.parse(input);
  await ownedAsset(deps, assetId);
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.favorite !== undefined) data.favoritedAt = patch.favorite ? new Date() : null;
  if (patch.kind !== undefined) data.kind = patch.kind;
  const updated = await deps.db.asset.update({ where: { id: assetId }, data });
  return toView(updated, await deps.storage.createDownloadUrl(updated.storageKey));
}

export async function deleteAsset(deps: AssetServiceDeps, assetId: string) {
  const asset = await ownedAsset(deps, assetId);
  await deps.db.asset.delete({ where: { id: assetId } });
  await deps.storage.delete(asset.storageKey).catch(() => {});
  return { id: assetId, deleted: true };
}
