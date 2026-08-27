import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db.ts";
import { currentUserId, getOrCreateProject } from "@/lib/auth/session.ts";
import { clipService } from "@/lib/api/service.ts";
import { listVideoClips } from "@/lib/api/clips.ts";
import { getStorage } from "@/lib/storage/index.ts";
import { ClipEditor } from "./clip-editor";
import { ClipComposer, type TranscriptRow } from "./clip-composer";
import type { PreviewWord } from "./clip-player";

export const dynamic = "force-dynamic";

function timecode(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const STATUS_TONE: Record<string, string> = {
  READY: "border-accent/40 text-accent",
  FAILED: "border-danger/40 text-danger",
};

export default async function VideoPage({ params }: { params: Promise<{ videoId: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const { videoId } = await params;

  const projectId = await getOrCreateProject(db, userId);
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      originalFilename: true,
      status: true,
      projectId: true,
      durationMs: true,
      storageKey: true,
    },
  });
  if (!video || video.projectId !== projectId) notFound();

  const [clips, segments, sourceUrl] = await Promise.all([
    listVideoClips(clipService(userId), videoId),
    db.transcriptSegment.findMany({
      where: { transcript: { videoId } },
      orderBy: { index: "asc" },
      select: {
        startMs: true,
        endMs: true,
        text: true,
        speaker: true,
        words: {
          orderBy: { startMs: "asc" },
          select: { text: true, startMs: true, endMs: true },
        },
      },
    }),
    getStorage().createDownloadUrl(video.storageKey),
  ]);

  const allWords = segments.flatMap((s) => s.words);
  /** Words fully inside a clip, rebased so 0 = clip start. */
  const wordsFor = (startMs: number, endMs: number): PreviewWord[] =>
    allWords
      .filter((w) => w.startMs >= startMs && w.endMs <= endMs)
      .map((w) => ({ text: w.text, startMs: w.startMs - startMs, endMs: w.endMs - startMs }));

  const transcriptRows: TranscriptRow[] = segments.map((s) => ({
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text,
    speaker: s.speaker,
  }));

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-3">
        <Link href="/dashboard" className="btn btn-ghost btn-sm w-fit -ml-2">
          ← All videos
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{video.originalFilename}</h1>
          <span className={`pill ${STATUS_TONE[video.status] ?? ""}`}>
            {video.status.toLowerCase()}
          </span>
          {video.durationMs ? (
            <span className="font-mono text-sm tabular-nums text-muted">
              {timecode(video.durationMs)}
            </span>
          ) : null}
        </div>
      </header>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Clips</h2>
          <span className="text-sm text-muted">{clips.length} total</span>
        </div>

        {clips.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-muted">
            No clips yet — they appear once transcription and analysis finish. Add one below.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {clips.map((c) => (
              <ClipEditor
                key={c.id}
                clip={c}
                sourceUrl={sourceUrl}
                words={wordsFor(c.startMs, c.endMs)}
              />
            ))}
          </div>
        )}
      </section>

      <ClipComposer videoId={videoId} rows={transcriptRows} />
    </main>
  );
}
