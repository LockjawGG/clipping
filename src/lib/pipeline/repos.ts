import type { PrismaClient } from "@prisma/client";

import { env } from "../env.ts";
import { db } from "../db.ts";
import { FfmpegRunner } from "../ffmpeg/run.ts";
import { ArgosTranslator } from "../translation/text.ts";
import { parseTranscriptTerms } from "../api/projects.ts";
import { NullFaceDetector } from "../faces/detector.ts";
import { YtDlpFetcher } from "./fetcher.ts";
import { FsSourceCache } from "./source-cache.ts";
import { RemotionCaptionRenderer } from "./remotion.ts";
import { getStorage } from "../storage/index.ts";
import { getTranscription } from "../transcription/index.ts";
import { getAnalysis } from "../analysis/index.ts";
import { enqueueJob } from "../jobs/prisma-store.ts";
import { join } from "node:path";

import type { Segment } from "../providers/types.ts";
import type { CaptionStyle } from "../captions/presets.ts";
import { textStyleFromParts } from "../captions/text-style.ts";
import { parseWordRules } from "../captions/word-rules.ts";
import type {
  ClipRepo,
  DbAspectRatio,
  LiveChunkRepo,
  PipelineDeps,
  RenderRepo,
  ThumbnailRepo,
  TranscriptRepo,
  VideoRepo,
} from "./deps.ts";

/** The scalar SubtitleConfig columns as a CaptionStyle. */
type ScalarSubtitleRow = {
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidthPx: number;
  backgroundColor: string | null;
  alignment: string;
  positionY: number;
  uppercase: boolean;
};

function scalarCaptionStyle(sc: ScalarSubtitleRow): CaptionStyle {
  return {
    fontFamily: sc.fontFamily,
    fontSizePx: sc.fontSizePx,
    fontWeight: sc.fontWeight,
    textColor: sc.textColor,
    highlightColor: sc.highlightColor,
    outlineColor: sc.outlineColor,
    outlineWidthPx: sc.outlineWidthPx,
    backgroundColor: sc.backgroundColor,
    alignment:
      sc.alignment === "left" || sc.alignment === "right"
        ? sc.alignment
        : "center",
    positionY: sc.positionY,
    uppercase: sc.uppercase,
  };
}

export function prismaVideoRepo(client: PrismaClient): VideoRepo {
  return {
    async get(id) {
      const v = await client.video.findUnique({
        where: { id },
        select: { id: true, storageKey: true, durationMs: true, status: true },
      });
      return v ?? null;
    },
    async applyProbe(id, info) {
      await client.video.update({
        where: { id },
        data: {
          durationMs: info.durationMs,
          width: info.width,
          height: info.height,
          fps: info.fps,
          videoCodec: info.videoCodec,
          audioCodec: info.audioCodec,
          audioChannels: info.audioChannels,
          sampleRate: info.sampleRate,
          hasAudio: info.hasAudio,
          sizeBytes: info.sizeBytes === null ? null : BigInt(Math.round(info.sizeBytes)),
          status: "UPLOADED",
        },
      });
    },
    async setStatus(id, status) {
      await client.video.update({ where: { id }, data: { status: status as never } });
    },
    async setError(id, message) {
      await client.video.update({
        where: { id },
        data: { status: "FAILED", errorMessage: message.slice(0, 2000) },
      });
    },
    async setFilename(id, originalFilename) {
      await client.video.update({ where: { id }, data: { originalFilename } });
    },
    async setStorageKey(id, storageKey) {
      await client.video.update({ where: { id }, data: { storageKey } });
    },
    async transcriptionTerms(id) {
      const v = await client.video.findUnique({
        where: { id },
        select: { project: { select: { transcriptTerms: true } } },
      });
      return parseTranscriptTerms(v?.project.transcriptTerms ?? "");
    },
  };
}

export function prismaTranscriptRepo(client: PrismaClient): TranscriptRepo {
  return {
    async save(videoId, result, opts) {
      const translatedTo = opts?.translatedTo ?? "";
      // A full-length transcript is hundreds of segments and thousands of
      // words. One `create` per segment blows past the default interactive-
      // transaction timeout against a hosted DB ("Transaction already closed"),
      // so: bulk-insert with `createMany`, and give the transaction real time.
      const CHUNK = 1000;
      return client.$transaction(
        async (tx) => {
          await tx.transcript.deleteMany({ where: { videoId, translatedTo } });
          const transcript = await tx.transcript.create({
            data: {
              videoId,
              translatedTo,
              provider: result.provider,
              model: result.model ?? null,
              language: result.language,
              confidence: result.confidence ?? null,
            },
          });

          await tx.transcriptSegment.createMany({
            data: result.segments.map((seg, i) => ({
              transcriptId: transcript.id,
              index: i,
              startMs: seg.startMs,
              endMs: seg.endMs,
              text: seg.text,
              speaker: seg.speaker ?? null,
              confidence: seg.confidence ?? null,
            })),
          });

          // Read the ids back in index order so words can be linked without a
          // round-trip per segment.
          const segRows = await tx.transcriptSegment.findMany({
            where: { transcriptId: transcript.id },
            orderBy: { index: "asc" },
            select: { id: true },
          });

          const words = result.segments.flatMap((seg, i) =>
            seg.words.map((w, wi) => ({
              segmentId: segRows[i].id,
              index: wi,
              startMs: w.startMs,
              endMs: w.endMs,
              text: w.text,
              confidence: w.confidence ?? null,
            })),
          );
          for (let i = 0; i < words.length; i += CHUNK) {
            await tx.transcriptWord.createMany({ data: words.slice(i, i + CHUNK) });
          }

          return { segmentCount: result.segments.length };
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
    },
    async primaryLanguage(videoId) {
      const t = await client.transcript.findFirst({
        where: { videoId, translatedTo: "" },
        select: { language: true },
      });
      return t?.language ?? null;
    },
    async loadSegments(videoId, translatedTo = "") {
      const rows = await client.transcriptSegment.findMany({
        where: { transcript: { videoId, translatedTo } },
        orderBy: { index: "asc" },
        include: { words: { orderBy: { index: "asc" } } },
      });
      return rows.map<Segment>((r) => ({
        text: r.text,
        startMs: r.startMs,
        endMs: r.endMs,
        speaker: r.speaker ?? undefined,
        confidence: r.confidence ?? undefined,
        words: r.words.map((w) => ({
          id: w.id,
          text: w.text,
          startMs: w.startMs,
          endMs: w.endMs,
          confidence: w.confidence ?? undefined,
        })),
      }));
    },
    async appendSegments(videoId, { provider, language, segments }) {
      if (segments.length === 0) return { appended: 0, fromIndex: 0 };
      return client.$transaction(
        async (tx) => {
          const transcript =
            (await tx.transcript.findFirst({
              where: { videoId, translatedTo: "" },
              select: { id: true },
            })) ??
            (await tx.transcript.create({
              data: { videoId, provider, language },
              select: { id: true },
            }));

          const last = await tx.transcriptSegment.aggregate({
            where: { transcriptId: transcript.id },
            _max: { index: true },
          });
          const fromIndex = (last._max.index ?? -1) + 1;

          await tx.transcriptSegment.createMany({
            data: segments.map((seg, i) => ({
              transcriptId: transcript.id,
              index: fromIndex + i,
              startMs: seg.startMs,
              endMs: seg.endMs,
              text: seg.text,
              speaker: seg.speaker ?? null,
              confidence: seg.confidence ?? null,
            })),
          });
          const segRows = await tx.transcriptSegment.findMany({
            where: { transcriptId: transcript.id, index: { gte: fromIndex } },
            orderBy: { index: "asc" },
            select: { id: true },
          });
          const words = segments.flatMap((seg, i) =>
            seg.words.map((w, wi) => ({
              segmentId: segRows[i].id,
              index: wi,
              startMs: w.startMs,
              endMs: w.endMs,
              text: w.text,
              confidence: w.confidence ?? null,
            })),
          );
          if (words.length) await tx.transcriptWord.createMany({ data: words });

          return { appended: segments.length, fromIndex };
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
    },
  };
}

export function prismaClipRepo(client: PrismaClient): ClipRepo {
  return {
    async replaceSuggested(videoId, clips) {
      return client.$transaction(async (tx) => {
        await tx.clip.deleteMany({ where: { videoId, origin: "AI_SUGGESTED" } });
        if (clips.length === 0) return 0;
        const res = await tx.clip.createMany({
          data: clips.map((c) => ({
            videoId,
            origin: "AI_SUGGESTED" as const,
            startMs: c.startMs,
            endMs: c.endMs,
            title: c.title,
            hook: c.hook || null,
            description: c.description || null,
            reason: c.reason || null,
            caption: c.caption || null,
            socialTitle: c.socialTitle || null,
            hashtags: c.hashtags,
            score: c.score,
          })),
        });
        return res.count;
      });
    },
  };
}

export function prismaRenderRepo(client: PrismaClient): RenderRepo {
  return {
    async loadTarget(renderId) {
      const render = await client.render.findUnique({
        where: { id: renderId },
        select: {
          clipId: true,
          quality: true,
          clip: {
            select: {
              startMs: true,
              endMs: true,
              aspectRatio: true,
              focalX: true,
              focalY: true,
              videoId: true,
              subtitleConfig: {
                select: {
                  animation: true,
                  fontFamily: true,
                  fontSizePx: true,
                  fontWeight: true,
                  textColor: true,
                  highlightColor: true,
                  outlineColor: true,
                  outlineWidthPx: true,
                  backgroundColor: true,
                  alignment: true,
                  positionY: true,
                  uppercase: true,
                  styleJson: true,
                  wordRulesJson: true,
                },
              },
              video: { select: { storageKey: true } },
              overlays: {
                orderBy: { zIndex: "asc" },
                select: {
                  kind: true,
                  content: true,
                  rotation: true,
                  styleJson: true,
                  animationJson: true,
                  x: true,
                  y: true,
                  scale: true,
                  opacity: true,
                  startMs: true,
                  endMs: true,
                  hidden: true,
                  asset: { select: { storageKey: true, kind: true } },
                },
              },
              wordStyles: {
                select: { wordId: true, color: true, bold: true, italic: true },
              },
            },
          },
        },
      });
      if (!render) return null;
      const sc = render.clip.subtitleConfig;
      return {
        clipId: render.clipId,
        videoId: render.clip.videoId,
        sourceKey: render.clip.video.storageKey,
        startMs: render.clip.startMs,
        endMs: render.clip.endMs,
        aspectRatio: render.clip.aspectRatio as DbAspectRatio,
        focalX: render.clip.focalX,
        focalY: render.clip.focalY,
        quality: render.quality as "P720" | "P1080" | "ORIGINAL",
        burnCaptions: sc !== null,
        overlays: render.clip.overlays
          .filter((o) => !o.hidden && o.asset && (o.asset.kind === "IMAGE" || o.asset.kind === "GIF"))
          .map((o) => ({
            storageKey: o.asset!.storageKey,
            animated: o.asset!.kind === "GIF",
            x: o.x,
            y: o.y,
            scale: o.scale,
            rotation: o.rotation,
            opacity: o.opacity,
            startMs: o.startMs,
            endMs: o.endMs,
            animationJson: o.animationJson,
          })),
        textOverlays: render.clip.overlays
          .filter((o) => !o.hidden && o.kind === "TEXT")
          .map((o) => ({
            text: o.content,
            x: o.x,
            y: o.y,
            scale: o.scale,
            rotation: o.rotation,
            opacity: o.opacity,
            startMs: o.startMs,
            endMs: o.endMs,
            styleJson: o.styleJson,
            animationJson: o.animationJson,
          })),
        wordStyles: Object.fromEntries(
          render.clip.wordStyles.map((s) => [
            s.wordId,
            { color: s.color, bold: s.bold, italic: s.italic },
          ]),
        ),
        captionAnimation: sc?.animation ?? "NONE",
        captionStyle: sc ? scalarCaptionStyle(sc) : null,
        textStyle: sc ? textStyleFromParts(scalarCaptionStyle(sc), sc.styleJson) : null,
        wordRules: parseWordRules(sc?.wordRulesJson ?? null),
      };
    },
    async begin(renderId) {
      await client.render.update({
        where: { id: renderId },
        data: { status: "PROCESSING", progress: 0, startedAt: new Date(), errorMessage: null },
      });
    },
    async complete(renderId, result) {
      await client.render.update({
        where: { id: renderId },
        data: {
          status: "COMPLETED",
          progress: 1,
          outputKey: result.outputKey,
          durationMs: result.durationMs,
          sizeBytes: result.sizeBytes === null ? null : BigInt(Math.round(result.sizeBytes)),
          finishedAt: new Date(),
        },
      });
    },
    async fail(renderId, message) {
      await client.render.update({
        where: { id: renderId },
        data: { status: "FAILED", errorMessage: message.slice(0, 2000), finishedAt: new Date() },
      });
    },
  };
}

export function prismaThumbnailRepo(client: PrismaClient): ThumbnailRepo {
  const shape = {
    startMs: true,
    endMs: true,
    video: { select: { storageKey: true } },
  } as const;
  return {
    async target(clipId) {
      const c = await client.clip.findUnique({ where: { id: clipId }, select: shape });
      return c ? { clipId, sourceKey: c.video.storageKey, startMs: c.startMs, endMs: c.endMs } : null;
    },
    async targetsForVideo(videoId) {
      const rows = await client.clip.findMany({
        where: { videoId, thumbnailKey: null },
        select: { id: true, ...shape },
      });
      return rows.map((c) => ({
        clipId: c.id,
        sourceKey: c.video.storageKey,
        startMs: c.startMs,
        endMs: c.endMs,
      }));
    },
    async setKey(clipId, thumbnailKey) {
      await client.clip.update({ where: { id: clipId }, data: { thumbnailKey } });
    },
    async videoPosterTarget(videoId) {
      const v = await client.video.findUnique({
        where: { id: videoId },
        select: { storageKey: true, durationMs: true, thumbnailKey: true },
      });
      return v
        ? {
            videoId,
            sourceKey: v.storageKey,
            durationMs: v.durationMs,
            hasThumbnail: v.thumbnailKey != null,
          }
        : null;
    },
    async setVideoKey(videoId, thumbnailKey) {
      await client.video.update({ where: { id: videoId }, data: { thumbnailKey } });
    },
  };
}

export function prismaLiveChunkRepo(client: PrismaClient): LiveChunkRepo {
  const shape = {
    id: true,
    videoId: true,
    index: true,
    startMs: true,
    storageKey: true,
    status: true,
    bytes: true,
  } as const;
  return {
    async get(id) {
      return client.liveChunk.findUnique({ where: { id }, select: shape });
    },
    async setStatus(id, status) {
      await client.liveChunk.updateMany({ where: { id }, data: { status } });
    },
    async listForVideo(videoId) {
      return client.liveChunk.findMany({
        where: { videoId },
        orderBy: { index: "asc" },
        select: shape,
      });
    },
    async deleteForVideo(videoId) {
      await client.liveChunk.deleteMany({ where: { videoId } });
    },
  };
}

/** Assemble the live dependency bag for the worker. */
export function buildPipelineDeps(): PipelineDeps {
  return {
    ffmpeg: new FfmpegRunner({ ffmpegPath: env.FFMPEG_PATH, ffprobePath: env.FFPROBE_PATH }),
    storage: getStorage(),
    source: new FsSourceCache({ storage: getStorage(), tempDir: env.TEMP_DIR }),
    transcription: getTranscription(),
    analysis: getAnalysis(),
    videos: prismaVideoRepo(db),
    transcripts: prismaTranscriptRepo(db),
    textTranslator: new ArgosTranslator({
      python: env.PYTHON_BIN,
      scriptPath: join(process.cwd(), "scripts", "translate.py"),
    }),
    clips: prismaClipRepo(db),
    renders: prismaRenderRepo(db),
    thumbnails: prismaThumbnailRepo(db),
    liveChunks: prismaLiveChunkRepo(db),
    captions: new RemotionCaptionRenderer(),
    faces: new NullFaceDetector(),
    fetcher: new YtDlpFetcher({
      binPath: env.YTDLP_PATH,
      maxBytes: env.MAX_UPLOAD_BYTES,
      impersonate: env.YTDLP_IMPERSONATE,
    }),
    queue: { enqueue: (input) => enqueueJob(db, input) },
    tempDir: env.TEMP_DIR,
  };
}
