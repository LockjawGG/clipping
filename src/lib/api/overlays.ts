import { z } from "zod";

import type { StorageProvider } from "../providers/types.ts";
import { TEXT_OVERLAY_ROLES } from "../overlays/roles.ts";
import { ApiError } from "./http.ts";

/**
 * Clip overlays: a library {@link Asset} (image / GIF) pinned onto a clip for a
 * time window. Position and size are normalised 0..1 so an overlay survives an
 * aspect-ratio change. `startMs` / `endMs` are on the *clip* timeline (0 = the
 * start of the clip); null on either side means "run to that edge of the clip".
 */

export { TEXT_OVERLAY_ROLES };
export type { TextOverlayRole } from "../overlays/roles.ts";

const unit = z.number().min(0).max(1);

export const createOverlaySchema = z.object({
  assetId: z.string().min(1),
  startMs: z.number().int().min(0).nullable().optional(),
  endMs: z.number().int().min(0).nullable().optional(),
  x: unit.optional(),
  y: unit.optional(),
  scale: z.number().min(0.02).max(4).optional(),
  rotation: z.number().min(-180).max(180).optional(),
  opacity: unit.optional(),
});

export const createTextOverlaySchema = z.object({
  content: z.string().trim().min(1).max(500),
  role: z.enum(TEXT_OVERLAY_ROLES).optional(),
  startMs: z.number().int().min(0).nullable().optional(),
  endMs: z.number().int().min(0).nullable().optional(),
  x: unit.optional(),
  y: unit.optional(),
  scale: z.number().min(0.02).max(4).optional(),
  rotation: z.number().min(-180).max(180).optional(),
  opacity: unit.optional(),
  styleJson: z.string().max(20000).nullable().optional(),
  animationJson: z.string().max(8000).nullable().optional(),
});

export const updateOverlaySchema = z
  .object({
    content: z.string().trim().min(1).max(500),
    role: z.enum(TEXT_OVERLAY_ROLES),
    startMs: z.number().int().min(0).nullable(),
    endMs: z.number().int().min(0).nullable(),
    x: unit,
    y: unit,
    scale: z.number().min(0.02).max(4),
    rotation: z.number().min(-180).max(180),
    opacity: unit,
    hidden: z.boolean(),
    styleJson: z.string().max(20000).nullable(),
    animationJson: z.string().max(8000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "nothing to update")
  .refine(
    (v) =>
      v.startMs == null ||
      v.endMs == null ||
      v.endMs === undefined ||
      v.startMs === undefined ||
      v.endMs > v.startMs,
    "endMs must be after startMs",
  );

interface OverlayRow {
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
  styleJson: string | null;
  animationJson: string | null;
  role: string;
}

interface AssetLite {
  id: string;
  userId: string;
  kind: string;
  name: string;
  storageKey: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

interface ClipLite {
  id: string;
  startMs: number;
  endMs: number;
  video: { projectId: string };
}

export interface OverlayDb {
  overlay: {
    findMany(args: {
      where: { clipId: string | { in: string[] } };
      orderBy?: unknown;
    }): Promise<OverlayRow[]>;
    findUnique(args: { where: { id: string } }): Promise<OverlayRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<OverlayRow>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<OverlayRow>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    aggregate(args: {
      where: { clipId: string };
      _max: { zIndex: true };
    }): Promise<{ _max: { zIndex: number | null } }>;
  };
  clip: {
    findUnique(args: {
      where: { id: string };
      select?: unknown;
    }): Promise<ClipLite | null>;
  };
  asset: {
    findUnique(args: { where: { id: string } }): Promise<AssetLite | null>;
    findMany(args: { where: { id: { in: string[] } } }): Promise<AssetLite[]>;
  };
}

export interface OverlayServiceDeps {
  db: OverlayDb;
  storage: StorageProvider;
  assertProjectOwned: (projectId: string) => Promise<void>;
  /** The signed-in user — owns the media library the overlay pulls from. */
  userId: string;
}

/** The image-ish asset kinds that can be dropped onto a clip as a visual overlay. */
const VISUAL_KINDS = new Set(["IMAGE", "GIF"]);

async function ownedClip(deps: OverlayServiceDeps, clipId: string): Promise<ClipLite> {
  const clip = await deps.db.clip.findUnique({
    where: { id: clipId },
    select: { id: true, startMs: true, endMs: true, video: { select: { projectId: true } } },
  });
  if (!clip) throw new ApiError(404, "clip not found");
  await deps.assertProjectOwned(clip.video.projectId);
  return clip;
}

async function ownedOverlay(
  deps: OverlayServiceDeps,
  overlayId: string,
): Promise<{ overlay: OverlayRow; clip: ClipLite }> {
  const overlay = await deps.db.overlay.findUnique({ where: { id: overlayId } });
  if (!overlay) throw new ApiError(404, "overlay not found");
  const clip = await ownedClip(deps, overlay.clipId);
  return { overlay, clip };
}

function toView(o: OverlayRow, url: string | null, assetName: string | null) {
  return {
    id: o.id,
    clipId: o.clipId,
    assetId: o.assetId,
    kind: o.kind,
    name: assetName ?? o.content,
    url,
    /** The text for a TEXT overlay; null for image/GIF. */
    text: o.kind === "TEXT" ? o.content : null,
    x: o.x,
    y: o.y,
    scale: o.scale,
    rotation: o.rotation,
    opacity: o.opacity,
    startMs: o.startMs,
    endMs: o.endMs,
    zIndex: o.zIndex,
    hidden: o.hidden,
    styleJson: o.styleJson ?? null,
    animationJson: o.animationJson ?? null,
    role: o.role ?? "title",
  };
}

export type OverlayView = ReturnType<typeof toView>;

export async function listClipOverlays(
  deps: OverlayServiceDeps,
  clipId: string,
): Promise<OverlayView[]> {
  await ownedClip(deps, clipId);
  const rows = await deps.db.overlay.findMany({
    where: { clipId },
    orderBy: { zIndex: "asc" },
  });
  return Promise.all(
    rows.map(async (o) => {
      if (!o.assetId) return toView(o, null, null);
      const asset = await deps.db.asset.findUnique({ where: { id: o.assetId } });
      const url = asset ? await deps.storage.createDownloadUrl(asset.storageKey) : null;
      return toView(o, url, asset?.name ?? null);
    }),
  );
}

/**
 * Overlays for many clips at once: one `overlay.findMany`, one `asset.findMany`,
 * and one signed URL per distinct storage key — instead of N queries per clip.
 * Ownership is the caller's responsibility (all `clipIds` must belong to a video
 * it has already checked). Every id in `clipIds` gets an entry.
 */
export async function listClipOverlaysBulk(
  deps: OverlayServiceDeps,
  clipIds: string[],
): Promise<Record<string, OverlayView[]>> {
  const out: Record<string, OverlayView[]> = Object.fromEntries(clipIds.map((id) => [id, []]));
  if (clipIds.length === 0) return out;

  const rows = await deps.db.overlay.findMany({
    where: { clipId: { in: clipIds } },
    orderBy: { zIndex: "asc" },
  });
  if (rows.length === 0) return out;

  const assetIds = [...new Set(rows.map((r) => r.assetId).filter((x): x is string => x != null))];
  const assets = assetIds.length
    ? await deps.db.asset.findMany({ where: { id: { in: assetIds } } })
    : [];
  const assetById = new Map(assets.map((a) => [a.id, a]));

  const urlByKey = new Map<string, string>();
  await Promise.all(
    [...new Set(assets.map((a) => a.storageKey))].map(async (key) => {
      urlByKey.set(key, await deps.storage.createDownloadUrl(key));
    }),
  );

  for (const o of rows) {
    const asset = o.assetId ? assetById.get(o.assetId) : undefined;
    const url = asset ? (urlByKey.get(asset.storageKey) ?? null) : null;
    (out[o.clipId] ??= []).push(toView(o, url, asset?.name ?? null));
  }
  return out;
}

export async function createOverlayFromAsset(
  deps: OverlayServiceDeps,
  clipId: string,
  input: unknown,
): Promise<OverlayView> {
  const parsed = createOverlaySchema.parse(input);
  const clip = await ownedClip(deps, clipId);

  const asset = await deps.db.asset.findUnique({ where: { id: parsed.assetId } });
  if (!asset || asset.userId !== deps.userId) throw new ApiError(404, "asset not found");
  if (!VISUAL_KINDS.has(asset.kind)) {
    throw new ApiError(422, "only image or GIF assets can be placed on a clip");
  }

  const clipLenMs = clip.endMs - clip.startMs;
  const startMs = parsed.startMs ?? null;
  const endMs = parsed.endMs ?? null;
  if (startMs !== null && startMs >= clipLenMs) {
    throw new ApiError(422, "startMs is past the end of the clip");
  }
  if (startMs !== null && endMs !== null && endMs <= startMs) {
    throw new ApiError(422, "endMs must be after startMs");
  }

  const top = await deps.db.overlay.aggregate({
    where: { clipId },
    _max: { zIndex: true },
  });

  const row = await deps.db.overlay.create({
    data: {
      clipId,
      kind: "IMAGE",
      content: asset.name,
      assetId: asset.id,
      x: parsed.x ?? 0.5,
      y: parsed.y ?? 0.5,
      scale: parsed.scale ?? 1,
      rotation: parsed.rotation ?? 0,
      opacity: parsed.opacity ?? 1,
      startMs,
      endMs,
      zIndex: (top._max.zIndex ?? 0) + 1,
    },
  });
  const url = await deps.storage.createDownloadUrl(asset.storageKey);
  return toView(row, url, asset.name);
}

/**
 * Add a freestanding text element to a clip. Unlike an image overlay it has no
 * asset — the text is stored in `content`, and `styleJson` / `animationJson`
 * carry the rich style and animation.
 */
export async function createTextOverlay(
  deps: OverlayServiceDeps,
  clipId: string,
  input: unknown,
): Promise<OverlayView> {
  const parsed = createTextOverlaySchema.parse(input);
  const clip = await ownedClip(deps, clipId);

  const clipLenMs = clip.endMs - clip.startMs;
  const startMs = parsed.startMs ?? null;
  const endMs = parsed.endMs ?? null;
  if (startMs !== null && startMs >= clipLenMs) {
    throw new ApiError(422, "startMs is past the end of the clip");
  }
  if (startMs !== null && endMs !== null && endMs <= startMs) {
    throw new ApiError(422, "endMs must be after startMs");
  }

  const top = await deps.db.overlay.aggregate({ where: { clipId }, _max: { zIndex: true } });

  const row = await deps.db.overlay.create({
    data: {
      clipId,
      kind: "TEXT",
      content: parsed.content,
      assetId: null,
      role: parsed.role ?? "title",
      x: parsed.x ?? 0.5,
      y: parsed.y ?? 0.35,
      scale: parsed.scale ?? 1,
      rotation: parsed.rotation ?? 0,
      opacity: parsed.opacity ?? 1,
      startMs,
      endMs,
      styleJson: parsed.styleJson ?? null,
      animationJson: parsed.animationJson ?? null,
      zIndex: (top._max.zIndex ?? 0) + 1,
    },
  });
  return toView(row, null, null);
}

export async function updateOverlay(
  deps: OverlayServiceDeps,
  overlayId: string,
  input: unknown,
): Promise<OverlayView> {
  const patch = updateOverlaySchema.parse(input);
  const { clip } = await ownedOverlay(deps, overlayId);

  const clipLenMs = clip.endMs - clip.startMs;
  if (patch.startMs != null && patch.startMs >= clipLenMs) {
    throw new ApiError(422, "startMs is past the end of the clip");
  }

  const data: Record<string, unknown> = {};
  for (const k of [
    "content",
    "role",
    "startMs",
    "endMs",
    "x",
    "y",
    "scale",
    "rotation",
    "opacity",
    "hidden",
    "styleJson",
    "animationJson",
  ] as const) {
    if (patch[k] !== undefined) data[k] = patch[k];
  }
  const row = await deps.db.overlay.update({ where: { id: overlayId }, data });
  return withAsset(deps, row);
}

/**
 * Move an overlay one step up or down the stack by swapping its `zIndex` with
 * the neighbour in that direction. A no-op (returns the overlay unchanged) when
 * it is already at the top / bottom.
 */
export async function reorderOverlay(
  deps: OverlayServiceDeps,
  overlayId: string,
  direction: "up" | "down",
): Promise<OverlayView> {
  const { overlay } = await ownedOverlay(deps, overlayId);
  const siblings = await deps.db.overlay.findMany({
    where: { clipId: overlay.clipId },
    orderBy: { zIndex: "asc" },
  });
  const ordered = [...siblings].sort((a, b) => a.zIndex - b.zIndex);
  const i = ordered.findIndex((o) => o.id === overlayId);
  const j = direction === "up" ? i + 1 : i - 1;
  if (i === -1 || j < 0 || j >= ordered.length) {
    return withAsset(deps, overlay); // already at the edge
  }
  const a = ordered[i];
  const b = ordered[j];
  const zi = a.zIndex;
  const zj = b.zIndex;
  const [rowA] = await Promise.all([
    deps.db.overlay.update({ where: { id: a.id }, data: { zIndex: zj } }),
    deps.db.overlay.update({ where: { id: b.id }, data: { zIndex: zi } }),
  ]);
  return withAsset(deps, rowA);
}

async function withAsset(deps: OverlayServiceDeps, row: OverlayRow): Promise<OverlayView> {
  if (!row.assetId) return toView(row, null, null);
  const asset = await deps.db.asset.findUnique({ where: { id: row.assetId } });
  if (!asset) return toView(row, null, null);
  return toView(row, await deps.storage.createDownloadUrl(asset.storageKey), asset.name);
}

export async function deleteOverlay(deps: OverlayServiceDeps, overlayId: string) {
  await ownedOverlay(deps, overlayId);
  await deps.db.overlay.delete({ where: { id: overlayId } });
  return { id: overlayId, deleted: true };
}
