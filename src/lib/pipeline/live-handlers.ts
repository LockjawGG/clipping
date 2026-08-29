import { appendFile, copyFile, mkdir, readFile, statfs } from "node:fs/promises";
import { dirname } from "node:path";

import type { JobHandler } from "../jobs/types.ts";
import type { Segment } from "../providers/types.ts";
import { jobWorkDir, type PipelineDeps, scratchPath } from "./deps.ts";

/**
 * Optional forced transcription language for live recordings (ISO code, e.g.
 * "es"). Empty is the default and the norm: the finalize pass sees the whole
 * recording, so Whisper detects the language itself and any language it picks
 * up is transcribed. Only set this to override a deployment that is always one
 * non-English language and wants to skip detection.
 */
const LIVE_LANGUAGE = process.env.LIVE_LANGUAGE?.trim() || "";

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

/** Bytes one 20s fragment of 1080p screen capture runs to, for rows predating
 *  the `bytes` column. Measured ~1.3 Mbit/s. */
const FRAGMENT_BYTES_FALLBACK = 3_300_000;

/**
 * Peak scratch a finalisation will occupy: the reassembled stream, the encoded
 * source beside it, and the 16kHz mono WAV handed to the transcriber.
 *
 * A re-encode is the expensive case (measured ~2.7x the WebM source at x264
 * veryfast), so budget for it rather than discovering ENOSPC an hour in.
 * Exported for tests — pure arithmetic, no filesystem.
 */
export function estimateFinalizeBytes(input: {
  fragmentBytes: number;
  fragmentCount: number;
  flushMs?: number;
}): number {
  const reassembled =
    input.fragmentBytes > 0 ? input.fragmentBytes : input.fragmentCount * FRAGMENT_BYTES_FALLBACK;
  const durationSec = (input.fragmentCount * (input.flushMs ?? 20_000)) / 1000;
  const wav = durationSec * 16_000 * 2; // 16kHz, mono, 16-bit
  return Math.round(reassembled + reassembled * 2.7 + wav);
}

const GB = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

export const liveFinalizeHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const video = await deps.videos.get(job.videoId);
  if (!video) throw new Error(`video ${job.videoId} not found`);

  const chunks = (await deps.liveChunks.listForVideo(job.videoId)).sort((a, b) => a.index - b.index);
  if (chunks.length === 0) {
    await deps.videos.setError(job.videoId, "Live recording had no audio.");
    return { chunks: 0 };
  }

  const work = jobWorkDir(deps.tempDir, job.id);

  // Check there is room before spending an hour discovering there isn't. A long
  // session is tens of GB of scratch, and ENOSPC halfway through a re-encode
  // surfaces as an opaque ffmpeg failure.
  const needBytes = estimateFinalizeBytes({
    fragmentBytes: chunks.reduce((n, c) => n + (c.bytes ?? 0), 0),
    fragmentCount: chunks.length,
  });
  try {
    const fs = await statfs(deps.tempDir);
    const freeBytes = Number(fs.bsize) * Number(fs.bavail);
    if (freeBytes < needBytes) {
      await deps.videos.setError(
        job.videoId,
        `Not enough disk to finish this recording: needs about ${GB(needBytes)}, ` +
          `${GB(freeBytes)} free. The recording is safe — free up space and retry.`,
      );
      return { chunks: chunks.length, needBytes, freeBytes, blocked: "insufficient disk" };
    }
  } catch {
    // statfs is unavailable on some mounts — proceed rather than block on it.
  }

  // Reassemble the MediaRecorder timeslice fragments by *binary* concatenation
  // in index order — they're one continuous stream that was flushed in pieces,
  // not independent files, so a container-level concat doesn't apply.
  const reassembled = scratchPath(work, "reassembled.webm");
  await mkdir(dirname(reassembled), { recursive: true });
  const part = scratchPath(work, "part.webm");
  let used = 0;
  let truncatedAt: number | null = null;
  for (let i = 0; i < chunks.length; i++) {
    // A fragment whose upload never landed (tab crashed / network) is skipped;
    // the stream is still decodable up to the gap.
    if (!(await deps.storage.exists(chunks[i].storageKey))) continue;
    await deps.storage.getToFile(chunks[i].storageKey, part);
    const body = await readFile(part);

    // A fragment shorter than the browser said it sent was cut off mid-upload.
    // Its own bytes are still decodable, but splicing the next fragment onto a
    // half-written frame corrupts everything after it — so take this one and
    // stop. Better a recording that ends early than one that plays garbage.
    const expected = chunks[i].bytes;
    if (expected !== null && body.byteLength < expected) {
      await appendFile(reassembled, body);
      used++;
      truncatedAt = chunks[i].index;
      break;
    }

    await appendFile(reassembled, body);
    used++;
    await setProgress((0.4 * (i + 1)) / chunks.length);
  }
  if (used === 0) {
    await deps.videos.setError(job.videoId, "Live recording had no usable audio.");
    return { chunks: 0 };
  }

  // Reassembled fragments are usually a byte-exact copy of one continuous
  // MediaRecorder stream, so a stream copy is all that's needed — and it is
  // ~200x faster than re-encoding (measured 550x realtime against 2.8x).
  //
  // But screen capture is variable-rate, and some sources emit packets that
  // share a decode timestamp. A browser cannot seek through that: it plays
  // black past the first seam. So take the cheap path, check the result, and
  // only pay for a re-encode when the check actually fails. Reading packet
  // timestamps never decodes, so the check costs ~1 minute on an 8h recording,
  // and the fallback re-encode (x264 veryfast, ~11x realtime) is only paid
  // when it's actually needed.
  const pre = await deps.ffmpeg.probe(reassembled, signal).catch(() => null);
  const hasVideo = !!pre && pre.videoCodec !== null;

  let source = scratchPath(work, "source.webm");
  let mime = "video/webm";
  let strategy: "copy" | "transcode" = "copy";
  try {
    await deps.ffmpeg.remux(reassembled, source, signal);
  } catch {
    await copyFile(reassembled, source);
  }

  if (hasVideo) {
    const ts = await deps.ffmpeg
      .videoTimestampReport(source, signal)
      .catch(() => ({ packets: 0, backwards: 1, duplicateRun: 0 }));
    // A rewinding timeline always breaks seeking; so does a long run of packets
    // stuck on one DTS (a real splice). A handful of shared timestamps is just
    // the millisecond granularity of WebM and seeks fine — don't pay for a
    // re-encode over that.
    const spliceRun = ts.duplicateRun > 8;
    if (ts.backwards > 0 || spliceRun) {
      strategy = "transcode";
      const mp4 = scratchPath(work, "source.mp4");
      await deps.ffmpeg.transcodeAv(reassembled, mp4, signal);
      source = mp4;
      mime = "video/mp4";
    }
  }

  // The stored object has to describe what it actually holds, or the player
  // gets the wrong content type and ffmpeg the wrong extension downstream.
  const storageKey =
    mime === "video/mp4" ? video.storageKey.replace(/\.webm$/, ".mp4") : video.storageKey;
  await deps.storage.putFile(storageKey, source, mime);
  if (storageKey !== video.storageKey) {
    await deps.videos.setStorageKey(job.videoId, storageKey);
    await deps.storage.delete(video.storageKey).catch(() => {});
  }
  await setProgress(0.55);

  const info = await deps.ffmpeg.probe(source, signal);
  await deps.videos.applyProbe(job.videoId, info);
  await setProgress(0.6);

  await deps.videos.setStatus(job.videoId, "TRANSCRIBING");
  const wav = scratchPath(work, "audio.wav");
  await deps.ffmpeg.extractAudio(source, wav, signal);
  const vocabulary = await Promise.resolve(deps.videos.transcriptionTerms?.(job.videoId) ?? []).catch(() => []);
  const result = await deps.transcription.transcribe(wav, {
    wordTimestamps: true,
    signal,
    ...(vocabulary.length ? { vocabulary } : {}),
    durationMs: info.durationMs ?? undefined,
    // Skip language detection when the deployment pins one — a touch faster and
    // it can't misfire on a quiet opening.
    ...(LIVE_LANGUAGE ? { language: LIVE_LANGUAGE } : {}),
    onProgress: (f) => void setProgress(0.6 + f * 0.35).catch(() => {}),
  });
  await deps.transcripts.save(job.videoId, result);

  await deps.videos.setStatus(job.videoId, "READY");
  await deps.queue.enqueue({ videoId: job.videoId, kind: "ANALYZE" });

  // The fragments are now baked into the source — drop their files and rows.
  for (const c of chunks) await deps.storage.delete(c.storageKey).catch(() => {});
  await deps.liveChunks.deleteForVideo(job.videoId).catch(() => {});

  return {
    chunks: chunks.length,
    usedChunks: used,
    segments: result.segments.length,
    strategy,
    ...(truncatedAt !== null ? { truncatedAtFragment: truncatedAt } : {}),
  };
};
