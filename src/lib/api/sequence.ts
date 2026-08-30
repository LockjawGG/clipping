import { z } from "zod";

import type { StorageProvider } from "../providers/types.ts";
import { insertionIndex, laneItems, packLanes } from "../sequence/lane.ts";
import { ApiError } from "./http.ts";

/**
 * Non-linear timeline for a single clip.
 *
 * A `Sequence` is optional and additive. Items are non-destructive — each
 * references a slice `[sourceIn,sourceOut]` of a source `Video` or library
 * `Asset`; source bytes are never touched.
 *
 * Pieces on one track are laid end to end: the lane's length is the sum of its
 * pieces, so dropping media in lengthens the export and trimming shortens it.
 * `timelineStart` is therefore derived from the durations after every change,
 * never authored — a stored position the layout disagreed with is how a
 * timeline and its export drift apart.
 *
 * A clip whose sequence is a single item covering its own window renders by the
 * original single-cut path, so opening this panel cannot change an export.
 */

export type SequenceTrackKind = "VIDEO" | "AUDIO" | "OVERLAY" | "TEXT";

/** Default on-timeline length for a still image dropped onto the timeline. */
const STILL_IMAGE_MS = 5_000;

/** Enough lanes to organise with, few enough that the panel stays readable. */
const MAX_TRACKS = 6;

/**
 * Injected media (image / GIF overlays) lives in its own `Overlay` table, not in
 * `SequenceItem`. The timeline still *shows* it: overlays are projected onto a
 * synthetic OVERLAY track so the user can see and re-time every piece of media
 * on the clip in one place. Their ids are prefixed so the client routes edits
 * back to `/api/overlays/:id` instead of the sequence-item endpoint.
 */
export const OVERLAY_ID_PREFIX = "ov_";
/** Each overlay gets its own synthetic track so it can be trimmed/placed
 *  independently over the full clip. Track id = this prefix + the overlay id. */
export const OVERLAY_TRACK_PREFIX = "ovtrk_";

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
    // Now that lanes are packed this is only a drop hint — the real position is
    // recomputed from the durations — so a value left of zero means "the very
    // start". Refusing it failed the whole edit: dragging the left edge of the
    // first piece outward sends a negative start, and the trim was lost while
    // the timeline optimistically showed it.
    timelineStart: z.number().int(),
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
  userId: string;
  kind: string;
  name: string;
  storageKey: string;
  durationMs: number | null;
}
interface OverlayLite {
  id: string;
  kind: string;
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
    delete(a: { where: { id: string } }): Promise<unknown>;
  };
  sequenceItem: {
    findUnique(a: { where: { id: string } }): Promise<ItemRow | null>;
    create(a: { data: Record<string, unknown> }): Promise<ItemRow>;
    update(a: { where: { id: string }; data: Record<string, unknown> }): Promise<ItemRow>;
    delete(a: { where: { id: string } }): Promise<unknown>;
    findMany(a: { where: { sequenceId: string } }): Promise<ItemRow[]>;
  };
}

export interface SequenceServiceDeps {
  db: SequenceDb;
  storage: StorageProvider;
  assertProjectOwned: (projectId: string) => Promise<void>;
  /** The signed-in user — owns the media library sequence items pull from. */
  userId: string;
}

/* ------------------------------------------------------------------ views */

export interface SequenceItemView {
  id: string;
  trackId: string;
  kind: "video" | "audio" | "image" | "text";
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
 * The clip's overlays — image / GIF *and* inserted text captions — projected as
 * read-through timeline items, ONE synthetic track per overlay so each can be
 * trimmed and placed independently over the whole clip. Hidden overlays are
 * skipped. `null` when the clip has none.
 *
 * Ordering: top layer (highest zIndex) first, matching the Layers panel.
 */
async function overlayItems(
  deps: SequenceServiceDeps,
  clipId: string,
  clipLenMs: number,
): Promise<{ tracks: SequenceView["tracks"]; items: SequenceItemView[] } | null> {
  const rows = await deps.db.overlay.findMany({
    where: { clipId },
    orderBy: { zIndex: "asc" },
  });
  // rows come back zIndex-ascending; reverse so the top layer is the top track.
  const visible = rows.filter((o) => !o.hidden && (o.assetId || o.kind === "TEXT")).reverse();
  if (visible.length === 0) return null;

  const tracks: SequenceView["tracks"] = [];
  const items = await Promise.all(
    visible.map(async (o, i): Promise<SequenceItemView> => {
      const isText = o.kind === "TEXT";
      const asset =
        !isText && o.assetId ? await deps.db.asset.findUnique({ where: { id: o.assetId } }) : null;
      const start = Math.max(0, o.startMs ?? 0);
      const end = Math.max(start + 1, o.endMs ?? clipLenMs);
      const name = asset?.name ?? o.content ?? (isText ? "caption" : "overlay");
      tracks.push({
        id: OVERLAY_TRACK_PREFIX + o.id,
        index: 1_000 + i, // after every real track, in layer order
        kind: isText ? "TEXT" : "OVERLAY",
        name,
        muted: false,
        locked: false,
      });
      return {
        id: OVERLAY_ID_PREFIX + o.id,
        trackId: OVERLAY_TRACK_PREFIX + o.id,
        kind: isText ? "text" : "image",
        name,
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

  return { tracks, items };
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
    tracks: [...view.tracks, ...ov.tracks],
    items: [...view.items, ...ov.items],
  };
}

/**
 * Re-lay every lane after a change.
 *
 * Positions are derived, never authored: a lane is its pieces end to end, so
 * `timelineStart` and `order` are recomputed from the durations and written
 * back. Doing it here, once, after every mutation is what keeps the stored
 * layout and the rendered one the same thing — the render reads `order`, the
 * user sees `timelineStart`, and a disagreement between them would show up as
 * an export that does not match the timeline.
 */
async function repackLanes(deps: SequenceServiceDeps, sequenceId: string): Promise<void> {
  const items = await deps.db.sequenceItem.findMany({ where: { sequenceId } });
  const packed = packLanes(items);
  for (const trackId of new Set(items.map((i) => i.trackId))) {
    const lane = laneItems(items, trackId);
    for (const [index, item] of lane.entries()) {
      const timelineStart = packed.get(item.id) ?? 0;
      if (item.timelineStart === timelineStart && item.order === index) continue;
      await deps.db.sequenceItem.update({
        where: { id: item.id },
        data: { timelineStart, order: index },
      });
    }
  }
}

/**
 * Renumber a lane so `item` sits where it was dropped.
 *
 * A drag reports pixels; packed lanes only have positions. The drop is resolved
 * to an index against the *other* pieces and the lane is renumbered around it,
 * leaving `repackLanes` to turn that order back into times.
 */
async function placeInLane(
  deps: SequenceServiceDeps,
  sequenceId: string,
  itemId: string,
  trackId: string,
  dropMs: number,
): Promise<void> {
  const items = await deps.db.sequenceItem.findMany({ where: { sequenceId } });
  const moving = items.find((i) => i.id === itemId);
  if (!moving) return;
  const at = insertionIndex(items, trackId, dropMs, itemId);
  const rest = laneItems(items, trackId).filter((i) => i.id !== itemId);
  const ordered = [...rest.slice(0, at), moving, ...rest.slice(at)];
  for (const [index, item] of ordered.entries()) {
    if (item.order === index && item.trackId === trackId) continue;
    await deps.db.sequenceItem.update({
      where: { id: item.id },
      data: { order: index, trackId },
    });
  }
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

/**
 * Add an empty video lane above the existing ones.
 *
 * Lanes are what makes "move this piece somewhere else" possible at all — with
 * one lane a drag can only reorder. They are numbered from the top like every
 * other editor, so a new lane takes index 0 and the rest shift down.
 */
export async function createSequenceTrack(
  deps: SequenceServiceDeps,
  sequenceId: string,
): Promise<SequenceView> {
  const seq = await ownedSequence(deps, sequenceId);
  if (seq.tracks.length >= MAX_TRACKS) {
    throw new ApiError(422, `a sequence can hold at most ${MAX_TRACKS} layers`);
  }
  const clip = await deps.db.clip.findUnique({ where: { id: seq.clipId } });
  const nextIndex = Math.max(-1, ...seq.tracks.map((t) => t.index)) + 1;
  await deps.db.sequenceTrack.create({
    data: {
      sequenceId,
      index: nextIndex,
      kind: "VIDEO",
      name: `V${seq.tracks.filter((t) => t.kind === "VIDEO").length + 1}`,
    },
  });
  const full = await deps.db.sequence.findUnique({
    where: { id: sequenceId },
    include: { tracks: true, items: true },
  });
  const clipLenMs = clip ? Math.max(1, clip.endMs - clip.startMs) : 1;
  return withOverlays(deps, await toView(deps, full ?? seq), clipLenMs);
}

/**
 * Remove an empty layer.
 *
 * Only an empty one, and never the last video lane. Deleting a lane that still
 * holds pieces would throw away footage as a side effect of tidying the panel —
 * the pieces have to be dragged somewhere first, which is a decision about the
 * edit rather than about the layout.
 */
export async function deleteSequenceTrack(
  deps: SequenceServiceDeps,
  sequenceId: string,
  trackId: string,
): Promise<SequenceView> {
  const seq = await ownedSequence(deps, sequenceId);
  const track = seq.tracks.find((t) => t.id === trackId);
  if (!track) throw new ApiError(404, "layer not found");

  const videoTracks = seq.tracks.filter((t) => t.kind === "VIDEO");
  if (track.kind === "VIDEO" && videoTracks.length <= 1) {
    throw new ApiError(422, "a timeline needs at least one video layer");
  }
  if (seq.items.some((i) => i.trackId === trackId)) {
    throw new ApiError(422, "move this layer's pieces somewhere else before removing it");
  }

  await deps.db.sequenceTrack.delete({ where: { id: trackId } });
  const clip = await deps.db.clip.findUnique({ where: { id: seq.clipId } });
  const full = await deps.db.sequence.findUnique({
    where: { id: sequenceId },
    include: { tracks: true, items: true },
  });
  const clipLenMs = clip ? Math.max(1, clip.endMs - clip.startMs) : 1;
  return withOverlays(deps, await toView(deps, full ?? seq), clipLenMs);
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
    if (!a || a.userId !== deps.userId) throw new ApiError(404, "source asset not found");
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
  // Dropping media into a lane makes the lane that much longer: the new piece
  // takes the position it was dropped at and everything shifts along.
  await placeInLane(deps, sequenceId, row.id, parsed.trackId, parsed.timelineStart);
  await repackLanes(deps, sequenceId);
  const fresh = await deps.db.sequenceItem.findUnique({ where: { id: row.id } });
  const view = await toView(deps, { ...seq, items: [fresh ?? row] });
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
  if (patch.sourceIn !== undefined) data.sourceIn = sourceIn;
  if (patch.sourceOut !== undefined) data.sourceOut = sourceOut;
  if (patch.trackId !== undefined) data.trackId = patch.trackId;
  if (patch.order !== undefined) data.order = patch.order;
  if (patch.name !== undefined) data.name = patch.name;

  await deps.db.sequenceItem.update({ where: { id: itemId }, data });
  // A dragged piece reports where it was dropped; lanes are packed, so that is
  // read as an order and the times are recomputed. Trimming needs no drop at
  // all — the pieces after it simply move up.
  if (patch.timelineStart !== undefined || patch.trackId !== undefined) {
    await placeInLane(
      deps,
      sequence.id,
      itemId,
      patch.trackId ?? item.trackId,
      Math.max(0, patch.timelineStart ?? item.timelineStart),
    );
  }
  await repackLanes(deps, sequence.id);
  const row = await deps.db.sequenceItem.findUnique({ where: { id: itemId } });
  const view = await toView(deps, { ...sequence, items: row ? [row] : [] });
  return view.items[0];
}

export async function deleteSequenceItem(deps: SequenceServiceDeps, itemId: string) {
  const { sequence } = await ownedItem(deps, itemId);
  await deps.db.sequenceItem.delete({ where: { id: itemId } });
  // Removing a piece closes the hole rather than leaving one.
  await repackLanes(deps, sequence.id);
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
      // Everything already after the cut has to move along to make room.
      order: order + 1,
      name,
    },
  });
  for (const other of await deps.db.sequenceItem.findMany({ where: { sequenceId } })) {
    if (other.trackId !== trackId || other.id === left.id || other.id === right.id) continue;
    if (other.order > order) {
      await deps.db.sequenceItem.update({ where: { id: other.id }, data: { order: other.order + 1 } });
    }
  }
  await repackLanes(deps, sequenceId);
  const rows = await deps.db.sequenceItem.findMany({ where: { sequenceId } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const view = await toView(deps, {
    ...sequence,
    items: [byId.get(left.id) ?? left, byId.get(right.id) ?? right],
  });
  return { left: view.items[0], right: view.items[1] };
}
