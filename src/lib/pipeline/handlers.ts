import { DEFAULT_SNAP_CONFIG } from "../clips/boundaries.ts";
import { refineSuggestions } from "../analysis/pipeline.ts";
import type { JobHandler } from "../jobs/types.ts";
import { type PipelineDeps, scratchPath } from "./deps.ts";

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
