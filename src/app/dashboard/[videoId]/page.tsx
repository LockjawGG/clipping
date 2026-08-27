import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db.ts";
import { currentUserId, getOrCreateProject } from "@/lib/auth/session.ts";
import { clipService } from "@/lib/api/service.ts";
import { listVideoClips } from "@/lib/api/clips.ts";
import { ClipEditor } from "./clip-editor";
import { NewClipForm } from "./new-clip-form";

export const dynamic = "force-dynamic";

function timecode(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default async function VideoPage({ params }: { params: Promise<{ videoId: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const { videoId } = await params;

  const projectId = await getOrCreateProject(db, userId);
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: { id: true, originalFilename: true, status: true, projectId: true, durationMs: true },
  });
  if (!video || video.projectId !== projectId) notFound();

  const [clips, segments] = await Promise.all([
    listVideoClips(clipService(userId), videoId),
    db.transcriptSegment.findMany({
      where: { transcript: { videoId } },
      orderBy: { index: "asc" },
      select: { startMs: true, endMs: true, text: true, speaker: true },
    }),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <div>
        <Link href="/dashboard" className="text-sm text-neutral-500 underline">
          ← All videos
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{video.originalFilename}</h1>
        <p className="text-sm text-neutral-500">
          {video.status}
          {video.durationMs ? ` · ${timecode(video.durationMs)}` : ""}
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Clips</h2>
        <div className="rounded border border-dashed border-neutral-300 p-3 dark:border-neutral-700">
          <NewClipForm videoId={videoId} />
        </div>
        {clips.length === 0 ? (
          <p className="text-neutral-500">
            No clips yet — they appear once transcription and analysis finish. You can also add one
            above.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {clips.map((c) => (
              <ClipEditor key={c.id} clip={c} />
            ))}
          </div>
        )}
      </section>

      {segments.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Transcript</h2>
          <ol className="flex flex-col gap-1 text-sm">
            {segments.map((seg, i) => (
              <li key={i} className="flex gap-3">
                <span className="shrink-0 tabular-nums text-neutral-400">{timecode(seg.startMs)}</span>
                <span>
                  {seg.speaker ? <span className="text-neutral-500">{seg.speaker}: </span> : null}
                  {seg.text}
                </span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-neutral-400">
            Read-only for now. Use the times here to add a clip above.
          </p>
        </section>
      )}
    </main>
  );
}
