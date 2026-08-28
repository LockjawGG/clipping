/**
 * One-off: enqueue a THUMBNAIL job for every READY video that has no poster yet.
 * The worker's thumbnailHandler now also grabs a video-level poster frame; this
 * just kicks it for videos ingested before that change.
 *
 *   node --experimental-strip-types scripts/backfill-video-posters.ts
 *
 * Safe to run repeatedly: it skips videos that already have a thumbnailKey and
 * videos that already have a QUEUED/PROCESSING THUMBNAIL job.
 */
import { db } from "../src/lib/db.ts";

async function main() {
  const videos = await db.video.findMany({
    where: { thumbnailKey: null, status: "READY" },
    select: { id: true, originalFilename: true },
  });

  if (videos.length === 0) {
    console.log("nothing to backfill — every READY video already has a poster");
    return;
  }

  let queued = 0;
  for (const v of videos) {
    const pending = await db.job.findFirst({
      where: { videoId: v.id, kind: "THUMBNAIL", status: { in: ["QUEUED", "PROCESSING"] } },
      select: { id: true },
    });
    if (pending) {
      console.log(`skip ${v.id} (${v.originalFilename?.slice(0, 40)}) — job ${pending.id} already pending`);
      continue;
    }
    const job = await db.job.create({
      data: { videoId: v.id, kind: "THUMBNAIL", payload: {} },
      select: { id: true },
    });
    queued++;
    console.log(`queued ${job.id} for ${v.id} (${v.originalFilename?.slice(0, 40)})`);
  }

  console.log(`\ndone — ${queued} THUMBNAIL job(s) queued. Make sure the worker is running.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
