import { redirect } from "next/navigation";

import { db } from "@/lib/db.ts";
import { currentUserId, getOrCreateProject } from "@/lib/auth/session.ts";
import { clipService, projectService } from "@/lib/api/service.ts";
import { listVideoClips } from "@/lib/api/clips.ts";
import { listProjects } from "@/lib/api/projects.ts";
import { listAssets } from "@/lib/api/assets.ts";
import { listClipOverlays } from "@/lib/api/overlays.ts";
import { listClipWordStyles } from "@/lib/api/caption-styles.ts";
import { assetService, overlayService, captionStyleService } from "@/lib/api/service.ts";
import { getStorage } from "@/lib/storage/index.ts";

import { WorkspaceShell } from "./workspace-shell";
import { LeftRail } from "./left-rail";
import { ContentRail } from "./content-rail";
import { EditorPane } from "./editor-pane";

export const metadata = { title: "Workspace · Clipper" };
export const dynamic = "force-dynamic";

function EmptyState({ hasVideos }: { hasVideos: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <p className="text-lg font-medium">
        {hasVideos ? "Pick a video to start editing" : "This project is empty"}
      </p>
      <p className="max-w-sm text-sm text-muted">
        {hasVideos
          ? "Choose one from the Raw content panel on the right."
          : "Add a video with the panel on the right — upload a file or paste a link."}
      </p>
    </div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; video?: string }>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const { project: wantProject, video: wantVideo } = await searchParams;

  await getOrCreateProject(db, userId);
  const projects = await listProjects(projectService(userId));
  const activeProjectId = projects.find((p) => p.id === wantProject)?.id ?? projects[0].id;

  const storage = getStorage();

  const [rawVideos, favRows, assets] = await Promise.all([
    db.video.findMany({
      where: { projectId: activeProjectId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        originalFilename: true,
        status: true,
        thumbnailKey: true,
        // Fallback poster while the video's own thumbnail is still pending:
        // the earliest clip that has one.
        clips: {
          where: { thumbnailKey: { not: null } },
          orderBy: { startMs: "asc" },
          take: 1,
          select: { thumbnailKey: true },
        },
        _count: { select: { clips: true } },
        jobs: {
          where: { status: { in: ["QUEUED", "PROCESSING"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { progress: true, kind: true, startedAt: true },
        },
      },
    }),
    db.clip.findMany({
      where: { savedToProjectId: activeProjectId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        videoId: true,
        thumbnailKey: true,
        video: { select: { originalFilename: true } },
      },
    }),
    listAssets(assetService(userId), activeProjectId),
  ]);

  const videos = await Promise.all(
    rawVideos.map(async (v) => ({
      id: v.id,
      name: v.originalFilename,
      status: v.status,
      thumbnailUrl: await (async () => {
        const key = v.thumbnailKey ?? v.clips[0]?.thumbnailKey ?? null;
        return key ? storage.createDownloadUrl(key) : null;
      })(),
      clipCount: v._count.clips,
      progress: v.jobs[0]?.progress ?? 0,
      jobKind: v.jobs[0]?.kind ?? null,
      startedAtMs: v.jobs[0]?.startedAt?.getTime() ?? null,
    })),
  );

  const favorites = await Promise.all(
    favRows.map(async (c) => ({
      id: c.id,
      title: c.title,
      videoId: c.videoId,
      videoName: c.video.originalFilename,
      thumbnailUrl: c.thumbnailKey ? await storage.createDownloadUrl(c.thumbnailKey) : null,
    })),
  );

  let editor = null;
  const activeVideoId = wantVideo ?? null;
  if (activeVideoId) {
    const video = await db.video.findUnique({
      where: { id: activeVideoId },
      select: {
        id: true,
        originalFilename: true,
        status: true,
        durationMs: true,
        storageKey: true,
        project: { select: { userId: true } },
      },
    });
    if (video && video.project.userId === userId) {
      const [clips, segments, sourceUrl] = await Promise.all([
        listVideoClips(clipService(userId), video.id),
        db.transcriptSegment.findMany({
          where: { transcript: { videoId: video.id } },
          orderBy: { index: "asc" },
          select: {
            startMs: true,
            endMs: true,
            speaker: true,
            words: {
              orderBy: { index: "asc" },
              select: { id: true, text: true, startMs: true, endMs: true },
            },
          },
        }),
        storage.createDownloadUrl(video.storageKey),
      ]);

      const allWords = segments.flatMap((s) => s.words);
      const wordsByClip = Object.fromEntries(
        clips.map((c) => [
          c.id,
          allWords
            .filter((w) => w.startMs >= c.startMs && w.endMs <= c.endMs)
            .map((w) => ({
              id: w.id,
              text: w.text,
              startMs: w.startMs - c.startMs,
              endMs: w.endMs - c.startMs,
            })),
        ]),
      );
      const transcriptRows = segments.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        speaker: s.speaker,
        words: s.words.map((w) => ({ id: w.id, text: w.text })),
      }));
      /** Segments that overlap each clip's window — the clip's own transcript. */
      const transcriptByClip = Object.fromEntries(
        clips.map((c) => [
          c.id,
          transcriptRows.filter((r) => r.endMs > c.startMs && r.startMs < c.endMs),
        ]),
      );

      /** Library assets dropped onto each clip, bottom-to-top. */
      const overlaysByClip = Object.fromEntries(
        await Promise.all(
          clips.map(async (c) => [c.id, await listClipOverlays(overlayService(userId), c.id)] as const),
        ),
      );

      /** Per-word caption style overrides, per clip. */
      const wordStylesByClip = Object.fromEntries(
        await Promise.all(
          clips.map(
            async (c) =>
              [c.id, await listClipWordStyles(captionStyleService(userId), c.id)] as const,
          ),
        ),
      );

      editor = (
        <EditorPane
          video={{
            id: video.id,
            name: video.originalFilename,
            status: video.status,
            durationMs: video.durationMs,
          }}
          sourceUrl={sourceUrl}
          clips={clips}
          wordsByClip={wordsByClip}
          transcriptByClip={transcriptByClip}
          overlaysByClip={overlaysByClip}
          wordStylesByClip={wordStylesByClip}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        />
      );
    }
  }

  return (
    <WorkspaceShell
      left={
        <LeftRail
          projects={projects}
          activeProjectId={activeProjectId}
          favorites={favorites}
          assets={assets}
        />
      }
      right={
        <ContentRail
          videos={videos}
          projects={projects}
          activeProjectId={activeProjectId}
          activeVideoId={activeVideoId}
        />
      }
    >
      {editor ?? <EmptyState hasVideos={videos.length > 0} />}
    </WorkspaceShell>
  );
}
