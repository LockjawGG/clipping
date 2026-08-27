import type { PrismaClient } from "@prisma/client";

import { env } from "../env.ts";
import { db } from "../db.ts";
import { FfmpegRunner } from "../ffmpeg/run.ts";
import { getStorage } from "../storage/index.ts";
import { getTranscription } from "../transcription/index.ts";
import { getAnalysis } from "../analysis/index.ts";
import { enqueueJob } from "../jobs/prisma-store.ts";
import type { Segment } from "../providers/types.ts";
import type {
  ClipRepo,
  DbAspectRatio,
  PipelineDeps,
  RenderRepo,
  TranscriptRepo,
  VideoRepo,
} from "./deps.ts";

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
  };
}

export function prismaTranscriptRepo(client: PrismaClient): TranscriptRepo {
  return {
    async save(videoId, result) {
      return client.$transaction(async (tx) => {
        await tx.transcript.deleteMany({ where: { videoId } });
        const transcript = await tx.transcript.create({
          data: {
            videoId,
            provider: result.provider,
            model: result.model ?? null,
            language: result.language,
            confidence: result.confidence ?? null,
          },
        });
        for (let i = 0; i < result.segments.length; i++) {
          const seg = result.segments[i];
          await tx.transcriptSegment.create({
            data: {
              transcriptId: transcript.id,
              index: i,
              startMs: seg.startMs,
              endMs: seg.endMs,
              text: seg.text,
              speaker: seg.speaker ?? null,
              confidence: seg.confidence ?? null,
              words: {
                createMany: {
                  data: seg.words.map((w, wi) => ({
                    index: wi,
                    startMs: w.startMs,
                    endMs: w.endMs,
                    text: w.text,
                    confidence: w.confidence ?? null,
                  })),
                },
              },
            },
          });
        }
        return { segmentCount: result.segments.length };
      });
    },
    async loadSegments(videoId) {
      const rows = await client.transcriptSegment.findMany({
        where: { transcript: { videoId } },
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
          text: w.text,
          startMs: w.startMs,
          endMs: w.endMs,
          confidence: w.confidence ?? undefined,
        })),
      }));
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
              subtitleConfig: { select: { id: true } },
              video: { select: { storageKey: true } },
            },
          },
        },
      });
      if (!render) return null;
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
        burnCaptions: render.clip.subtitleConfig !== null,
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

/** Assemble the live dependency bag for the worker. */
export function buildPipelineDeps(): PipelineDeps {
  return {
    ffmpeg: new FfmpegRunner({ ffmpegPath: env.FFMPEG_PATH, ffprobePath: env.FFPROBE_PATH }),
    storage: getStorage(),
    transcription: getTranscription(),
    analysis: getAnalysis(),
    videos: prismaVideoRepo(db),
    transcripts: prismaTranscriptRepo(db),
    clips: prismaClipRepo(db),
    renders: prismaRenderRepo(db),
    queue: { enqueue: (input) => enqueueJob(db, input) },
    tempDir: env.TEMP_DIR,
  };
}
