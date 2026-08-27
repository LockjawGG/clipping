import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db.ts";
import { currentUserId, getOrCreateProject } from "@/lib/auth/session.ts";
import { clipService } from "@/lib/api/service.ts";
import { listVideoClips } from "@/lib/api/clips.ts";
import { RenderButton } from "./render-button";

export const dynamic = "force-dynamic";

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export default async function VideoPage({ params }: { params: Promise<{ videoId: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const { videoId } = await params;

  const projectId = await getOrCreateProject(db, userId);
  const video = await db.video.findUnique({
    where: { id: videoId },
    select: { id: true, originalFilename: true, status: true, projectId: true },
  });
  if (!video || video.projectId !== projectId) notFound();

  const clips = await listVideoClips(clipService(userId), videoId);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12">
      <div>
        <Link href="/dashboard" className="text-sm text-neutral-500 underline">
          ← All videos
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{video.originalFilename}</h1>
        <p className="text-sm text-neutral-500">{video.status}</p>
      </div>

      {clips.length === 0 ? (
        <p className="text-neutral-500">
          No clips yet. They appear once transcription and analysis finish.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {clips.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{c.title}</p>
                <p className="text-sm text-neutral-500">
                  {seconds(c.startMs)}–{seconds(c.endMs)} · {c.aspectRatio.replace(/_/g, " ").toLowerCase()}
                  {c.score !== null ? ` · score ${c.score.toFixed(2)}` : ""}
                </p>
                {c.render && (
                  <p className="mt-1 text-xs text-neutral-500">
                    render: {c.render.status.toLowerCase()}
                    {c.render.status !== "COMPLETED" && c.render.status !== "FAILED"
                      ? ` (${Math.round(c.render.progress * 100)}%)`
                      : ""}
                    {c.render.downloadUrl && (
                      <>
                        {" · "}
                        <a href={c.render.downloadUrl} className="underline">
                          download
                        </a>
                      </>
                    )}
                  </p>
                )}
              </div>
              <RenderButton clipId={c.id} hasRender={c.render !== null} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
