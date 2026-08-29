import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { JobHandler } from "../jobs/types.ts";
import type { Segment } from "../providers/types.ts";
import { jobWorkDir, type PipelineDeps, scratchPath } from "./deps.ts";

/** Pin the language for short isolated chunks (too little to auto-detect). */
const LIVE_LANGUAGE = process.env.LIVE_LANGUAGE ?? "en";

/**
 * Live-capture handlers.
 *
 *   LIVE_TRANSCRIBE  — legacy per-chunk transcription. No longer enqueued (the
 *                      browser records one continuous stream now), kept so any
 *                      in-flight job from an older client still resolves.
 *   LIVE_FINALIZE    — Stop pressed: reassemble the recording fragments into the
 *                      video's source, probe it, transcribe the whole thing once
 *                      at full quality, then ANALYZE.
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

  // Reassemble the MediaRecorder timeslice fragments by *binary* concatenation
  // in index order — they're one continuous stream that was flushed in pieces,
  // not independent files, so a container-level concat doesn't apply.
  const reassembled = scratchPath(work, "reassembled.webm");
  await mkdir(dirname(reassembled), { recursive: true });
  const part = scratchPath(work, "part.webm");
  let used = 0;
  for (let i = 0; i < chunks.length; i++) {
    // A fragment whose upload never landed (tab crashed / network) is skipped;
    // the stream is still decodable up to the gap.
    if (!(await deps.storage.exists(chunks[i].storageKey))) continue;
    await deps.storage.getToFile(chunks[i].storageKey, part);
    await appendFile(reassembled, await readFile(part));
    used++;
    await setProgress((0.4 * (i + 1)) / chunks.length);
  }
  if (used === 0) {
    await deps.videos.setError(job.videoId, "Live recording had no usable audio.");
    return { chunks: 0 };
  }

  // Stream-copy remux to regenerate timestamps + a seek index. If a fragment
  // was dropped mid-stream and the copy fails, fall back to the raw reassembly.
  const source = scratchPath(work, "source.webm");
  try {
    await deps.ffmpeg.remux(reassembled, source, signal);
  } catch {
    await copyFile(reassembled, source);
  }
  await deps.storage.putFile(video.storageKey, source, "video/webm");
  await setProgress(0.55);

  const info = await deps.ffmpeg.probe(source, signal);
  await deps.videos.applyProbe(job.videoId, info);
  await setProgress(0.6);

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

  // Storage cleanup for the now-redundant fragments (best effort).
  for (const c of chunks) await deps.storage.delete(c.storageKey).catch(() => {});

  return { chunks: chunks.length, usedChunks: used, segments: result.segments.length };
};
