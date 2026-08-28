import { z } from "zod";

import type { StorageProvider } from "../providers/types.ts";
import { ApiError } from "./http.ts";

/**
 * Non-linear timeline for a single clip.
 *
 * A `Sequence` is optional and additive: a clip without one renders as it always
 * has (its plain [startMs,endMs] cut). With one, the render composes the items.
 * Items are non-destructive — each references a slice `[sourceIn,sourceOut]` of a
 * source `Video` or library `Asset`; source bytes are never touched.
 */

export type SequenceTrackKind = "VIDEO" | "AUDIO" | "OVERLAY";

/** Default on-timeline length for a still image dropped onto the timeline. */
const STILL_IMAGE_MS = 5_000;

/**
 * Injected media (image / GIF overlays) lives in its own `Overlay` table, not in
 * `SequenceItem`. The timeline still *shows* it: overlays are projected onto a
 * synthetic OVERLAY track so the user can see and re-time every piece of media
 * on the clip in one place. Their ids are prefixed so the client routes edits
 * back to `/api/overlays/:id` instead of the sequence-item endpoint.
 */
export const OVERLAY_TRACK_ID = "ov_track";
export const OVERLAY_ID_PREFIX = "ov_";

export const updateSequenceSchema = z
  .object({
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    fps: z.number().int().min(1).max(120),
    snap: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "nothing to update");

export const createItemSchema = z
  .object({
    trackId: z.string().min(1),
    sourceVideoId: z.string().min(1).optional(),
    sourceAssetId: z.string().min(1).optional(),
    timelineStart: z.number().int().min(0),
    sourceIn: z.number().int().min(0).default(0),
    sourceOut: z.number().int().min(1).optional(),
    name: z.string().max(300).optional(),
  })
  .refine(
    (v) => Boolean(v.sourceVideoId) !== Boolean(v.sourceAssetId),
    "provide exactly one of sourceVideoId / sourceAssetId",
  );

export const updateItemSchema = z
  .object({
    timelineStart: z.number().int().min(0),
    sourceIn: z.number().int().min(0),
    sourceOut: z.number().int().min(1),
    trackId: z.string().min(1),
    order: z.number().int(),
    name: z.string().trim().max(300).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "nothing to update")
  .refine(
    (v) => v.sourceIn == null || v.sourceOut == null || v.sourceOut > v.sourceIn,
    "sourceOut must be after sourceIn",
  );

export const splitItemSchema = z.object({ atMs: z.number().int().min(0) });

/* --------------------------------------------------------------- db shapes */

interface TrackRow {
  id: string;
  sequenceId: string;
  index: number;
  kind: string;
  name: string;
  muted: boolean;
  locked: boolean;
}
interface ItemRow {
  id: string;
  sequenceId: string;
  trackId: string;
  sourceVideoId: string | null;
  sourceAssetId: string | null;
  timelineStart: number;
  sourceIn: number;
  sourceOut: number;
  order: number;
  name: string | null;
}
interface SeqRow {
  id: string;
  clipId: string;
  width: number;
  height: number;
  fps: number;
  snap: boolean;
  tracks: TrackRow[];
  items: ItemRow[];
}
interface ClipLite {
  id: string;
  startMs: number;
  endMs: number;
  videoId: string;
  video: { projectId: string };
}
interface VideoLite {
  id: string;
  projectId: string;
  storageKey: string;
  durationMs: number | null;
  hasAudio: boolean;
  originalFilename: string;
}
interface AssetLite {
  id: string;
  projectId: string;
  kind: string;
  name: string;
  storageKey: string;
  durationMs: number | null;
}
interface OverlayLite {
  id: string;
  assetId: string | null;
  content: string;
  startMs: number | null;
  endMs: number | null;
  hidden: boolean;
}

export interface SequenceDb {
  clip: {
    findUnique(a: { where: { id: string }; select?: unknown }): Promise<ClipLite | null>;
  };
  video: {
    findUnique(a: { where: { id: string } }): Promise<VideoLite | null>;
  };
  asset: {
    findUnique(a: { where: { id: string } }): Promise<AssetLite | null>;
  };
  overlay: {
    findMany(a: { where: { clipId: string }; orderBy?: unknown }): Promise<OverlayLite[]>;
  };
  sequence: {
    findUnique(a: {
      where: { id?: string; clipId?: string };
      include?: unknown;
    }): Promise<SeqRow | null>;
    create(a: { data: Record<string, unknown>; include?: unknown }): Promise<SeqRow>;
    update(a: { where: { id: string }; data: Record<string, unknown> }): Promise<SeqRow>;
  };
  sequenceTrack: {
    create(a: { data: Record<string, unknown> }): Promise<TrackRow>;
  };
  sequenceItem: {
    findUnique(a: { where: { id: string } }): Promise<ItemRow | null>;
    create(a: { data: Record<string, unknown> }): Promise<ItemRow>;
    update(a: { where: { id: string }; data: Record<string, unknown> }): Promise<ItemRow>;
    delete(a: { where: { id: string } }): Promise<unknown>;
  };
}

export interface SequenceServiceDeps {
  db: SequenceDb;
  storage: StorageProvider;
  assertProjectOwned: (projectId: string) => Promise<void>;
}

/* ------------------------------------------------------------------ views */

export interface SequenceItemView {
  id: string;
  trackId: string;
  kind: "video" | "audio" | "image";
  name: string;
  timelineStart: number;
  sourceIn: number;
  sourceOut: number;
  sourceDurationMs: number;
  sourceUrl: string | null;
  sourceVideoId: string | null;
  sourceAssetId: string | null;
}
export interface SequenceView {
  id: string;
  clipId: string;
  width: number;
  height: number;
  fps: number;
  snap: boolean;
  tracks: Array<{
    id: string;
    index: number;
    kind: SequenceTrackKind;
    name: string;
    muted: boolean;
    locked: boolean;
  }>;
  items: SequenceItemView[];
}

/* ------------------------------------------------------------ ownership */

async function ownedClip(deps: SequenceServiceDeps, clipId: string): Promise<ClipLite> {
  const clip = await deps.db.clip.findUnique({
    where: { id: clipId },
    select: {
      id: true,
      startMs: true,
      endMs: true,
      videoId: true,
      video: { select: { projectId: true } },
    },
  });
  if (!clip) throw new ApiError(404, "clip not found");
  await deps.assertProjectOwned(clip.video.projectId);
  return clip;
}

async function ownedSequence(deps: SequenceServiceDeps, sequenceId: string): Promise<SeqRow> {
  const seq = await deps.db.sequence.findUnique({
    where: { id: sequenceId },
    include: { tracks: true, items: true },
  });
  if (!seq) throw new ApiError(404, "sequence not found");
  await ownedClip(deps, seq.clipId);
  return seq;
}

async function ownedItem(
  deps: SequenceServiceDeps,
  itemId: string,
): Promise<{ item: ItemRow; sequence: SeqRow }> {
  const item = await deps.db.sequenceItem.findUnique({ where: { id: itemId } });
  if (!item) throw new ApiError(404, "sequence item not found");
  const sequence = await ownedSequence(deps, item.sequenceId);
  return { item, sequence };
}

/* --------------------------------------------------------- source resolve */

/** Duration + signed URL + kind for whichever source an item points at. */
async function resolveSource(
  deps: SequenceServiceDeps,
  it: Pick<ItemRow, "sourceVideoId" | "sourceAssetId">,
): Promise<{ kind: "video" | "audio" | "image"; durationMs: number; url: string | null; name: string }> {
  if (it.sourceVideoId) {
    const v = await deps.db.video.findUnique({ where: { id: it.sourceVideoId } });
    return {
      kind: "video",
      durationMs: v?.durationMs ?? 0,
      url: v ? await deps.storage.createDownloadUrl(v.storageKey) : null,
      name: v?.originalFilename ?? "video",
    };
  }
  const a = it.sourceAssetId
    ? await deps.db.asset.findUnique({ where: { id: it.sourceAssetId } })
    : null;
  const isAudio = a?.kind === "AUDIO" || a?.kind === "SFX";
  return {
    kind: isAudio ? "audio" : "image",
    durationMs: a?.durationMs ?? (isAudio ? 0 : STILL_IMAGE_MS),
    url: a ? await deps.storage.createDownloadUrl(a.storageKey) : null,
    name: a?.name ?? "asset",
  };
}

async function toView(deps: SequenceServiceDeps, seq: SeqRow): Promise<SequenceView> {
  const items = await Promise.all(
    [...seq.items]
      .sort((a, b) => a.timelineStart - b.timelineStart || a.order - b.order)
      .map(async (it): Promise<SequenceItemView> => {
        const s = await resolveSource(deps, it);
        return {
          id: it.id,
          trackId: it.trackId,
          kind: s.kind,
          name: it.name ?? s.name,
          timelineStart: it.timelineStart,
          sourceIn: it.sourceIn,
          sourceOut: it.sourceOut,
          sourceDurationMs: s.durationMs,
          sourceUrl: s.url,
          sourceVideoId: it.sourceVideoId,
          sourceAssetId: it.sourceAssetId,
        };
      }),
  );
  return {
    id: seq.id,
    clipId: seq.clipId,
    width: seq.width,
    height: seq.height,
    fps: seq.fps,
    snap: seq.snap,
    tracks: [...seq.tracks]
      .sort((a, b) => a.index - b.index)
      .map((t) => ({
        id: t.id,
        index: t.index,
        kind: t.kind as SequenceTrackKind,
        name: t.name,
        muted: t.muted,
        locked: t.locked,
      })),
    items,
  };
}

/* ----------------------------------------------------- overlay projection */

/**
 * The clip's image / GIF overlays, projected as read-through timeline items on a
 * synthetic OVERLAY track. Hidden overlays and text/emoji overlays (no asset)
 * are skipped. `null` when the clip has no visible overlays — the caller then
 * adds nothing.
 */
async function overlayItems(
  deps: SequenceServiceDeps,
  clipId: string,
  clipLenMs: number,
): Promise<{ track: SequenceView["tracks"][number]; items: SequenceItemView[] } | null> {
  const rows = await deps.db.overlay.findMany({
    where: { clipId },
    orderBy: { zIndex: "asc" },
  });
  const visible = rows.filter((o) => !o.hidden && o.assetId);
  if (visible.length === 0) return null;

  const items = await Promise.all(
    visible.map(async (o): Promise<SequenceItemView> => {
      const asset = o.assetId ? await deps.db.asset.findUnique({ where: { id: o.assetId } }) : null;
      const start = Math.max(0, o.startMs ?? 0);
      const end = Math.max(start + 1, o.endMs ?? clipLenMs);
      return {
        id: OVERLAY_ID_PREFIX + o.id,
        trackId: OVERLAY_TRACK_ID,
        kind: "image",
        name: asset?.name ?? o.content ?? "overlay",
        timelineStart: start,
        sourceIn: 0,
        sourceOut: end - start,
        // Overlays have no fixed source length — allow trimming/extending across
        // the whole clip.
        sourceDurationMs: Math.max(clipLenMs, end),
        sourceUrl: asset ? await deps.storage.createDownloadUrl(asset.storageKey) : null,
        sourceVideoId: null,
        sourceAssetId: o.assetId,
      };
    }),
  );

  return {
    track: {
      id: OVERLAY_TRACK_ID,
      // after every real track
      index: 1_000,
      kind: "OVERLAY",
      name: "Overlays",
      muted: false,
      locked: false,
    },
    items,
  };
}

/** Merge the clip's overlay projection into a freshly built sequence view. */
async function withOverlays(
  deps: SequenceServiceDeps,
  view: SequenceView,
  clipLenMs: number,
): Promise<SequenceView> {
  const ov = await overlayItems(deps, view.clipId, clipLenMs);
  if (!ov) return view;
  return {
    ...view,
    tracks: [...view.tracks, ov.track],
    items: [...view.items, ...ov.items],
  };
}

/* --------------------------------------------------------------- service */

/**
 * The clip's timeline, created on first open: one VIDEO track seeded with a
 * single item that is exactly the clip's current [startMs,endMs] window. From
 * there the user splits / trims / rearranges without ever changing the clip.
 */
export async function getOrCreateClipSequence(
  deps: SequenceServiceDeps,
  clipId: string,
): Promise<SequenceView> {
  const clip = await ownedClip(deps, clipId);
  const clipLenMs = Math.max(1, clip.endMs - clip.startMs);

  const existing = await deps.db.sequence.findUnique({
    where: { clipId },
    include: { tracks: true, items: true },
  });
  if (existing) return withOverlays(deps, await toView(deps, existing), clipLenMs);

  const seq = await deps.db.sequence.create({
    data: { clipId },
    include: { tracks: true, items: true },
  });
  const track = await deps.db.sequenceTrack.create({
    data: { sequenceId: seq.id, index: 0, kind: "VIDEO", name: "V1" },
  });
  const item = await deps.db.sequenceItem.create({
    data: {
      sequenceId: seq.id,
      trackId: track.id,
      sourceVideoId: clip.videoId,
      timelineStart: 0,
      sourceIn: clip.startMs,
      sourceOut: Math.max(clip.startMs + 1, clip.endMs),
      order: 0,
    },
  });
  return withOverlays(deps, await toView(deps, { ...seq, tracks: [track], items: [item] }), clipLenMs);
}

export async function updateSequence(
  deps: SequenceServiceDeps,
  sequenceId: string,
  input: unknown,
): Promise<SequenceView> {
  const patch = updateSequenceSchema.parse(input);
  const seq = await ownedSequence(deps, sequenceId);
  const clip = await deps.db.clip.findUnique({ where: { id: seq.clipId } });
  const clipLenMs = clip ? Math.max(1, clip.endMs - clip.startMs) : 1;
  const updated = await deps.db.sequence.update({ where: { id: sequenceId }, data: patch });
  const full = await deps.db.sequence.findUnique({
    where: { id: sequenceId },
    include: { tracks: true, items: true },
  });
  return withOverlays(deps, await toView(deps, full ?? updated), clipLenMs);
}

export async function createSequenceItem(
  deps: SequenceServiceDeps,
  sequenceId: string,
  input: unknown,
): Promise<SequenceItemView> {
  const parsed = createItemSchema.parse(input);
  const seq = await ownedSequence(deps, sequenceId);
  if (!seq.tracks.some((t) => t.id === parsed.trackId)) {
    throw new ApiError(422, "trackId is not part of this sequence");
  }

  const src = await resolveSource(deps, {
    sourceVideoId: parsed.sourceVideoId ?? null,
    sourceAssetId: parsed.sourceAssetId ?? null,
  });
  // ownership of the dropped source: it must belong to a project the user owns
  if (parsed.sourceVideoId) {
    const v = await deps.db.video.findUnique({ where: { id: parsed.sourceVideoId } });
    if (!v) throw new ApiError(404, "source video not found");
    await deps.assertProjectOwned(v.projectId);
  } else {
    const a = await deps.db.asset.findUnique({ where: { id: parsed.sourceAssetId! } });
    if (!a) throw new ApiError(404, "source asset not found");
    await deps.assertProjectOwned(a.projectId);
  }

  const maxOut = src.durationMs > 0 ? src.durationMs : STILL_IMAGE_MS;
  const sourceOut = Math.min(parsed.sourceOut ?? maxOut, maxOut);
  if (sourceOut <= parsed.sourceIn) throw new ApiError(422, "empty source range");

  const row = await deps.db.sequenceItem.create({
    data: {
      sequenceId,
      trackId: parsed.trackId,
      sourceVideoId: parsed.sourceVideoId ?? null,
      sourceAssetId: parsed.sourceAssetId ?? null,
      timelineStart: parsed.timelineStart,
      sourceIn: parsed.sourceIn,
      sourceOut,
      order: seq.items.filter((i) => i.trackId === parsed.trackId).length,
      name: parsed.name ?? null,
    },
  });
  const view = await toView(deps, { ...seq, items: [row] });
  return view.items[0];
}

export async function updateSequenceItem(
  deps: SequenceServiceDeps,
  itemId: string,
  input: unknown,
): Promise<SequenceItemView> {
  const patch = updateItemSchema.parse(input);
  const { item, sequence } = await ownedItem(deps, itemId);

  if (patch.trackId && !sequence.tracks.some((t) => t.id === patch.trackId)) {
    throw new ApiError(422, "trackId is not part of this sequence");
  }

  const src = await resolveSource(deps, item);
  const cap = src.durationMs > 0 ? src.durationMs : Number.MAX_SAFE_INTEGER;
  const sourceIn = Math.max(0, patch.sourceIn ?? item.sourceIn);
  const sourceOut = Math.min(cap, patch.sourceOut ?? item.sourceOut);
  if (sourceOut <= sourceIn) throw new ApiError(422, "empty source range");

  const data: Record<string, unknown> = {};
  if (patch.timelineStart !== undefined) data.timelineStart = Math.max(0, patch.timelineStart);
  if (patch.sourceIn !== undefined) data.sourceIn = sourceIn;
  if (patch.sourceOut !== undefined) data.sourceOut = sourceOut;
  if (patch.trackId !== undefined) data.trackId = patch.trackId;
  if (patch.order !== undefined) data.order = patch.order;
  if (patch.name !== undefined) data.name = patch.name;

  const row = await deps.db.sequenceItem.update({ where: { id: itemId }, data });
  const view = await toView(deps, { ...sequence, items: [row] });
  return view.items[0];
}

export async function deleteSequenceItem(deps: SequenceServiceDeps, itemId: string) {
  await ownedItem(deps, itemId);
  await deps.db.sequenceItem.delete({ where: { id: itemId } });
  return { id: itemId, deleted: true };
}

/**
 * Cut an item in two at `atMs` on the sequence timeline. The left part keeps the
 * id and gets a shorter `sourceOut`; the right part is a new item starting at
 * `atMs`. Rejects a cut that isn't strictly inside the item.
 */
export async function splitSequenceItem(
  deps: SequenceServiceDeps,
  itemId: string,
  input: unknown,
): Promise<{ left: SequenceItemView; right: SequenceItemView }> {
  const { atMs } = splitItemSchema.parse(input);
  const { item, sequence } = await ownedItem(deps, itemId);

  // Snapshot the fields we need before the update — Prisma returns fresh rows,
  // but a mutation-in-place client could otherwise change `item` under us.
  const { sequenceId, trackId, sourceVideoId, sourceAssetId, sourceIn, sourceOut, order, name } =
    item;
  const offset = atMs - item.timelineStart; // ms into the item
  if (offset <= 0 || offset >= sourceOut - sourceIn) {
    throw new ApiError(422, "split point is outside the item");
  }
  const splitSource = sourceIn + offset;

  const left = await deps.db.sequenceItem.update({
    where: { id: itemId },
    data: { sourceOut: splitSource },
  });
  const right = await deps.db.sequenceItem.create({
    data: {
      sequenceId,
      trackId,
      sourceVideoId,
      sourceAssetId,
      timelineStart: atMs,
      sourceIn: splitSource,
      sourceOut,
      order: order + 1,
      name,
    },
  });
  const view = await toView(deps, { ...sequence, items: [left, right] });
  return { left: view.items[0], right: view.items[1] };
}
