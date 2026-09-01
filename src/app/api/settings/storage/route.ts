import path from "node:path";

import { route } from "@/lib/api/http.ts";
import { scanStorage, deleteOrphans } from "@/lib/api/storage-maintenance.ts";
import { parseLines } from "@/lib/voiceover/sync.ts";
import { db } from "@/lib/db.ts";
import { env } from "@/lib/env.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the database currently points at, plus the live entity ids for
 * the convention-derived files (`audio.wav`, posters, thumbs, takes) that no
 * column names but the pipeline reads back.
 */
async function buildScanInput() {
  const [videos, clips, voiceovers, renders, assets, chunks] = await Promise.all([
    db.video.findMany({ select: { id: true, storageKey: true, thumbnailKey: true } }),
    db.clip.findMany({ select: { id: true, thumbnailKey: true } }),
    db.voiceover.findMany({ select: { id: true, linesJson: true } }),
    db.render.findMany({ select: { id: true, outputKey: true } }),
    db.asset.findMany({ select: { storageKey: true } }),
    db.liveChunk.findMany({ select: { storageKey: true } }),
  ]);

  const referencedKeys = new Set<string>();
  for (const v of videos) {
    referencedKeys.add(v.storageKey);
    if (v.thumbnailKey) referencedKeys.add(v.thumbnailKey);
  }
  for (const c of clips) if (c.thumbnailKey) referencedKeys.add(c.thumbnailKey);
  for (const r of renders) if (r.outputKey) referencedKeys.add(r.outputKey);
  for (const a of assets) referencedKeys.add(a.storageKey);
  for (const l of chunks) referencedKeys.add(l.storageKey);
  for (const vo of voiceovers) {
    for (const line of parseLines(vo.linesJson)) {
      if (line.audioKey) referencedKeys.add(line.audioKey);
    }
  }

  return {
    referencedKeys,
    liveIds: {
      videos: new Set(videos.map((v) => v.id)),
      clips: new Set(clips.map((c) => c.id)),
      voiceovers: new Set(voiceovers.map((v) => v.id)),
      renders: new Set(renders.map((r) => r.id)),
    },
  };
}

function storageRoot(): string {
  return path.resolve(env.LOCAL_STORAGE_DIR);
}

/** GET /api/settings/storage — usage plus what a cleanup would reclaim. */
export const GET = route(async () => {
  await requireUserId();
  const report = await scanStorage(storageRoot(), await buildScanInput());
  // The key list can be long; the UI needs numbers, not ten thousand paths.
  return Response.json({
    totalBytes: report.totalBytes,
    fileCount: report.fileCount,
    orphanBytes: report.orphanBytes,
    orphanCount: report.orphanCount,
  });
});

/** POST /api/settings/storage — delete the orphans found by a fresh scan. */
export const POST = route(async () => {
  await requireUserId();
  // Re-scan at deletion time rather than trusting a stale list from GET: the
  // store changes constantly and deletion has no undo.
  const report = await scanStorage(storageRoot(), await buildScanInput());
  const removed = await deleteOrphans(storageRoot(), report.orphans);
  return Response.json({ removed, reclaimedBytes: report.orphanBytes });
});
