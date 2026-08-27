import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_SNAP_CONFIG } from "../clips/boundaries.ts";
import { refineSuggestions } from "../analysis/pipeline.ts";
import { buildCues, toSrt } from "../captions/layout.ts";
import type { JobHandler } from "../jobs/types.ts";
import { type PipelineDeps, scratchPath, toAspectPreset } from "./deps.ts";

/**
 * The processing chain. Each handler does one step and enqueues the next, so a
 * failure only retries that step. `Job.videoId` carries the subject; `payload`
 * carries step-specific options.
 *
 *   PROBE → EXTRACT_AUDIO → TRANSCRIBE → ANALYZE
 */

const AUDIO_MIME = "audio/wav";

function audioKeyFor(videoId: string): string {
  return `videos/${videoId}/audio.wav`;
}

/** PROBE: read container metadata, store it on the Video, queue audio extraction. */
export const probeHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const video = await deps.videos.get(job.videoId);
  if (!video) throw new Error(`video ${job.videoId} not found`);

  await deps.videos.setStatus(job.videoId, "PROBING");
  const source = scratchPath(deps.tempDir, job.videoId, "source");
  await deps.storage.getToFile(video.storageKey, source);
  await setProgress(0.5);

  const info = await deps.ffmpeg.probe(source, signal);
  await deps.videos.applyProbe(job.videoId, info);

  await deps.queue.enqueue({ videoId: job.videoId, kind: "EXTRACT_AUDIO" });
  return info;
};

/** EXTRACT_AUDIO: 16kHz mono WAV for the transcriber, uploaded to storage. */
export const extractAudioHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const video = await deps.videos.get(job.videoId);
  if (!video) throw new Error(`video ${job.videoId} not found`);

  const source = scratchPath(deps.tempDir, job.videoId, "source");
  const wav = scratchPath(deps.tempDir, job.videoId, "audio.wav");
  await deps.storage.getToFile(video.storageKey, source);
  await setProgress(0.3);

  await deps.ffmpeg.extractAudio(source, wav, signal);
  await setProgress(0.75);

  const audioKey = audioKeyFor(job.videoId);
  await deps.storage.putFile(audioKey, wav, AUDIO_MIME);

  await deps.queue.enqueue({ videoId: job.videoId, kind: "TRANSCRIBE", payload: { audioKey } });
  return { audioKey };
};

interface TranscribePayload {
  audioKey?: string;
  language?: string;
  diarize?: boolean;
}

/** TRANSCRIBE: run the transcription provider, persist segments + words. */
export const transcribeHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const payload = (job.payload ?? {}) as TranscribePayload;
  const audioKey = payload.audioKey ?? audioKeyFor(job.videoId);
  const wav = scratchPath(deps.tempDir, job.videoId, "audio.wav");
  await deps.storage.getToFile(audioKey, wav);

  await deps.videos.setStatus(job.videoId, "TRANSCRIBING");
  await setProgress(0.2);

  const result = await deps.transcription.transcribe(wav, {
    language: payload.language,
    diarize: payload.diarize,
    wordTimestamps: true,
    signal,
  });
  const { segmentCount } = await deps.transcripts.save(job.videoId, result);
  await setProgress(0.9);

  await deps.videos.setStatus(job.videoId, "READY");
  await deps.queue.enqueue({ videoId: job.videoId, kind: "ANALYZE" });
  return { segmentCount, language: result.language };
};

interface AnalyzePayload {
  minClipMs?: number;
  maxClipMs?: number;
  maxClips?: number;
  style?: string;
  maxTotalRatio?: number;
}

/** ANALYZE: ask the analysis provider for clips, refine, persist as suggestions. */
export const analyzeHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const video = await deps.videos.get(job.videoId);
  if (!video) throw new Error(`video ${job.videoId} not found`);

  const segments = await deps.transcripts.loadSegments(job.videoId);
  if (segments.length === 0) throw new Error(`no transcript segments for video ${job.videoId}`);

  const p = (job.payload ?? {}) as AnalyzePayload;
  const options = {
    minClipMs: p.minClipMs ?? DEFAULT_SNAP_CONFIG.minClipMs,
    maxClipMs: p.maxClipMs ?? DEFAULT_SNAP_CONFIG.maxClipMs,
    maxClips: p.maxClips ?? 10,
    style: p.style,
    signal,
  };

  const raw = await deps.analysis.suggestClips(segments, options);
  await setProgress(0.7);

  const durationMs = video.durationMs ?? segments[segments.length - 1].endMs;
  const refined = refineSuggestions(raw, segments, durationMs, {
    ...options,
    maxTotalRatio: p.maxTotalRatio ?? 0.3,
  });

  const clipCount = await deps.clips.replaceSuggested(job.videoId, refined);
  return { clipCount, consideredSegments: segments.length };
};

interface RenderPayload {
  renderId: string;
}

const CRF_BY_QUALITY: Record<string, number> = { ORIGINAL: 16, P1080: 20, P720: 24 };

/** RENDER: cut the clip, reframe to its aspect (burning captions), upload the MP4. */
export const renderHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const { renderId } = (job.payload ?? {}) as RenderPayload;
  if (!renderId) throw new Error("RENDER job payload is missing renderId");

  const target = await deps.renders.loadTarget(renderId);
  if (!target) throw new Error(`render ${renderId} not found`);

  await deps.renders.begin(renderId);

  try {
    const source = scratchPath(deps.tempDir, "render", renderId, "source");
    const cut = scratchPath(deps.tempDir, "render", renderId, "cut.mp4");
    const final = scratchPath(deps.tempDir, "render", renderId, "final.mp4");

    await deps.storage.getToFile(target.sourceKey, source);
    await setProgress(0.2);

    await deps.ffmpeg.cut(
      source,
      cut,
      { startMs: target.startMs, endMs: target.endMs, crf: CRF_BY_QUALITY[target.quality] ?? 20 },
      signal,
    );
    await setProgress(0.55);

    // Captions: the clip's own words, rebased onto the clip timeline.
    let subtitlePath: string | undefined;
    if (target.burnCaptions) {
      const segments = await deps.transcripts.loadSegments(target.videoId);
      const words = segments
        .flatMap((s) => s.words)
        .filter((w) => w.startMs >= target.startMs && w.endMs <= target.endMs);
      if (words.length > 0) {
        subtitlePath = scratchPath(deps.tempDir, "render", renderId, "captions.srt");
        await mkdir(dirname(subtitlePath), { recursive: true });
        await writeFile(subtitlePath, toSrt(buildCues(words), target.startMs), "utf8");
      }
    }

    const aspect = toAspectPreset(target.aspectRatio);
    const needsReframe = aspect !== "16:9" || subtitlePath !== undefined;
    if (needsReframe) {
      await deps.ffmpeg.reframe(
        cut,
        final,
        {
          aspect,
          focalX: target.focalX ?? undefined,
          focalY: target.focalY ?? undefined,
          subtitlePath,
        },
        signal,
      );
    }
    await setProgress(0.85);

    const output = needsReframe ? final : cut;
    const info = await deps.ffmpeg.probe(output, signal);
    const outputKey = `renders/${renderId}/output.mp4`;
    await deps.storage.putFile(outputKey, output, "video/mp4");

    await deps.renders.complete(renderId, {
      outputKey,
      sizeBytes: info.sizeBytes,
      durationMs: info.durationMs,
    });
    return { outputKey, durationMs: info.durationMs };
  } catch (err) {
    await deps.renders.fail(renderId, err instanceof Error ? err.message : String(err));
    throw err;
  }
};
