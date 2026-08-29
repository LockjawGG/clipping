import type { JobHandler } from "../jobs/types.ts";
import type { Segment } from "../providers/types.ts";
import { jobWorkDir, type PipelineDeps, scratchPath } from "./deps.ts";

/** Pin the language for short live chunks (8s is too little to auto-detect). */
const LIVE_LANGUAGE = process.env.LIVE_LANGUAGE ?? "en";

/**
 * Live-capture handlers.
 *
 *   LIVE_TRANSCRIBE  — one ~8s chunk: download → wav → transcribe → append to
 *                      the video's transcript, offset onto the session timeline.
 *   LIVE_FINALIZE    — Stop pressed: concat every chunk into the video's source,
 *                      probe it, re-transcribe the whole thing at full quality
 *                      (replacing the rolling transcript), then ANALYZE.
 */

interface LiveTranscribePayload {
  chunkId?: string;
}

const offsetSegments = (segments: Segment[], byMs: number): Segment[] =>
  segments.map((s) => ({
    ...s,
    startMs: s.startMs + byMs,
    endMs: s.endMs + byMs,
    words: s.words.map((w) => ({ ...w, startMs: w.startMs + byMs, endMs: w.endMs + byMs })),
  }));

export const liveTranscribeHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal }) => {
  const { chunkId } = (job.payload ?? {}) as LiveTranscribePayload;
  if (!chunkId) throw new Error("LIVE_TRANSCRIBE payload is missing chunkId");

  const chunk = await deps.liveChunks.get(chunkId);
  if (!chunk) return { skipped: "chunk gone" };
  if (chunk.status === "DONE") return { skipped: "already done" };

  // The browser registers the chunk (this job) and PUTs its bytes as two
  // separate requests, so the upload may still be in flight when we get here.
  // Not a failure — let the job retry rather than burning the chunk.
  if (!(await deps.storage.exists(chunk.storageKey))) {
    throw new Error(`live chunk ${chunk.index} not uploaded yet — will retry`);
  }

  const work = jobWorkDir(deps.tempDir, job.id);
  const raw = scratchPath(work, "chunk.webm");
  const wav = scratchPath(work, "chunk.wav");

  try {
    await deps.storage.getToFile(chunk.storageKey, raw);
    await deps.ffmpeg.extractAudio(raw, wav, signal);
    const result = await deps.transcription.transcribe(wav, {
      wordTimestamps: true,
      signal,
      ...(LIVE_LANGUAGE ? { language: LIVE_LANGUAGE } : {}),
    });

    await deps.transcripts.appendSegments(chunk.videoId, {
      provider: result.provider,
      language: result.language,
      segments: offsetSegments(result.segments, chunk.startMs),
    });
    await deps.liveChunks.setStatus(chunkId, "DONE");
    return { segments: result.segments.length, offsetMs: chunk.startMs };
  } catch (err) {
    await deps.liveChunks.setStatus(chunkId, "FAILED").catch(() => {});
    throw err;
  }
};

export const liveFinalizeHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const video = await deps.videos.get(job.videoId);
  if (!video) throw new Error(`video ${job.videoId} not found`);

  const chunks = (await deps.liveChunks.listForVideo(job.videoId)).sort((a, b) => a.index - b.index);
  if (chunks.length === 0) {
    await deps.videos.setError(job.videoId, "Live recording had no audio.");
    return { chunks: 0 };
  }

  const work = jobWorkDir(deps.tempDir, job.id);
  const localPaths: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    // A chunk whose upload never landed (browser died / network) is skipped
    // rather than sinking the whole recording.
    if (!(await deps.storage.exists(chunks[i].storageKey))) continue;
    const p = scratchPath(work, `${String(i).padStart(5, "0")}.webm`);
    await deps.storage.getToFile(chunks[i].storageKey, p);
    localPaths.push(p);
    await setProgress((0.4 * (i + 1)) / chunks.length);
  }
  if (localPaths.length === 0) {
    await deps.videos.setError(job.videoId, "Live recording had no usable audio.");
    return { chunks: 0 };
  }

  const source = scratchPath(work, "source.webm");
  // Screen recordings carry a video stream — stream-copy concat of WebM leaves
  // broken timestamps (plays black past the first segment), so re-encode those.
  // Mic-only recordings are audio and copy-concat cleanly.
  const firstProbe = await deps.ffmpeg.probe(localPaths[0], signal).catch(() => null);
  const hasVideo = !!firstProbe && firstProbe.videoCodec !== null;
  if (hasVideo) await deps.ffmpeg.concatAv(localPaths, source, signal);
  else await deps.ffmpeg.concatAudio(localPaths, source, signal);
  await deps.storage.putFile(video.storageKey, source, "video/webm");
  await setProgress(0.55);

  const info = await deps.ffmpeg.probe(source, signal);
  await deps.videos.applyProbe(job.videoId, info);
  await setProgress(0.6);

  // Full re-transcription replaces the rolling one.
  await deps.videos.setStatus(job.videoId, "TRANSCRIBING");
  const wav = scratchPath(work, "audio.wav");
  await deps.ffmpeg.extractAudio(source, wav, signal);
  const result = await deps.transcription.transcribe(wav, {
    wordTimestamps: true,
    signal,
    durationMs: info.durationMs ?? undefined,
    onProgress: (f) => void setProgress(0.6 + f * 0.35).catch(() => {}),
  });
  await deps.transcripts.save(job.videoId, result);

  await deps.videos.setStatus(job.videoId, "READY");
  await deps.queue.enqueue({ videoId: job.videoId, kind: "ANALYZE" });

  // Storage cleanup for the now-redundant chunks (best effort).
  for (const c of chunks) await deps.storage.delete(c.storageKey).catch(() => {});

  return { chunks: chunks.length, segments: result.segments.length };
};
