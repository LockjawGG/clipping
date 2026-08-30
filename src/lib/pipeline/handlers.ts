import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_SNAP_CONFIG } from "../clips/boundaries.ts";
import { refineSuggestions } from "../analysis/pipeline.ts";
import { buildCues, toSrt, toStyledSrt } from "../captions/layout.ts";
import { DEFAULT_CAPTION_STYLE, remotionPreset } from "../captions/presets.ts";
import { captionNeedsRemotion } from "../captions/text-style.ts";
import { parseAudioFeatures, parseStoredFeatures, serializeFeatures } from "../audio/features.ts";
import { buildSuggestions } from "../worker-ai/suggest.ts";
import { parseProfile } from "../learning/profile.ts";
import { clipLengthBias } from "../learning/apply.ts";
import {
  parseLines,
  placeLines,
  serializeLines,
  staleLines,
  type VoiceLine,
} from "../voiceover/sync.ts";
import {
  audioSpans,
  censoredIndices,
  censorHasAudioWork,
  censorHasWork,
} from "../censor/detect.ts";
import { type CaptionCensorMode, maskWords } from "../censor/mask.ts";
import { parseWordOverrides } from "../censor/overrides.ts";
import { ASPECT_DIMENSIONS, type CaptionBurnStyle } from "../ffmpeg/args.ts";
import { type FocalPoint, resampleTrack } from "../faces/track.ts";
import {
  focusNeedsZoom,
  focusToFocalTrack,
  focusToSamples,
  parseFocusTrack,
} from "../focus/keyframes.ts";
import type { JobHandler } from "../jobs/types.ts";
import {
  jobWorkDir,
  type PipelineDeps,
  type RenderOverlay,
  scratchPath,
  toAspectPreset,
} from "./deps.ts";

/**
 * The processing chain. Each handler does one step and enqueues the next, so a
 * failure only retries that step. `Job.videoId` carries the subject; `payload`
 * carries step-specific options.
 *
 *   (FETCH) → PROBE → EXTRACT_AUDIO → TRANSCRIBE → ANALYZE → THUMBNAIL
 *
 * The source video is downloaded once (`deps.source`) and reused across steps;
 * transient outputs go under a per-job dir the worker wipes afterwards.
 */

const AUDIO_MIME = "audio/wav";

function audioKeyFor(videoId: string): string {
  return `videos/${videoId}/audio.wav`;
}

interface FetchPayload {
  url?: string;
}

/** FETCH: download a URL, put it in storage (and prime the source cache), start PROBE. */
export const fetchHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const { url } = (job.payload ?? {}) as FetchPayload;
  if (!url) throw new Error("FETCH job payload is missing url");

  const video = await deps.videos.get(job.videoId);
  if (!video) throw new Error(`video ${job.videoId} not found`);

  const local = deps.source.localPath(job.videoId);
  // Map the download 0..1 onto 0..0.85 of the job; storage + finalize take the rest.
  let lastPct = -1;
  const result = await deps.fetcher.fetch(url, local, signal, (f) => {
    const pct = Math.floor(f * 100);
    if (pct > lastPct) {
      lastPct = pct;
      void setProgress(Math.min(0.85, f * 0.85)).catch(() => {});
    }
  });
  await setProgress(0.9);

  await deps.storage.putFile(video.storageKey, local, "video/mp4");
  if (result.title) await deps.videos.setFilename(job.videoId, result.title.slice(0, 500));
  await deps.videos.setStatus(job.videoId, "UPLOADED");

  await deps.queue.enqueue({ videoId: job.videoId, kind: "PROBE" });
  return { title: result.title ?? null, durationSec: result.durationSec ?? null };
};

/** PROBE: read container metadata, store it on the Video, queue audio extraction. */
export const probeHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const video = await deps.videos.get(job.videoId);
  if (!video) throw new Error(`video ${job.videoId} not found`);

  await deps.videos.setStatus(job.videoId, "PROBING");
  const source = await deps.source.ensureLocal(job.videoId, video.storageKey, signal);
  await setProgress(0.5);

  const info = await deps.ffmpeg.probe(source, signal);
  await deps.videos.applyProbe(job.videoId, info);

  await deps.queue.enqueue({ videoId: job.videoId, kind: "EXTRACT_AUDIO" });
  return info;
};

/** EXTRACT_AUDIO: 16kHz mono WAV for the transcriber, uploaded to storage. */
interface ExtractAudioPayload {
  /** Forced transcription language for the TRANSCRIBE this chains into. */
  language?: string;
  /** "translate" runs Whisper's speech-translation (English target only). */
  task?: "transcribe" | "translate";
  /** Which stored transcript the result replaces: "" source, or a lang code. */
  translatedTo?: string;
}

export const extractAudioHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const { language, task, translatedTo } = (job.payload ?? {}) as ExtractAudioPayload;
  const video = await deps.videos.get(job.videoId);
  if (!video) throw new Error(`video ${job.videoId} not found`);

  const source = await deps.source.ensureLocal(job.videoId, video.storageKey, signal);
  const wav = scratchPath(jobWorkDir(deps.tempDir, job.id), "audio.wav");
  await setProgress(0.3);

  await deps.ffmpeg.extractAudio(source, wav, signal);
  await setProgress(0.75);

  const audioKey = audioKeyFor(job.videoId);
  await deps.storage.putFile(audioKey, wav, AUDIO_MIME);

  await deps.queue.enqueue({
    videoId: job.videoId,
    kind: "TRANSCRIBE",
    payload: {
      audioKey,
      ...(language ? { language } : {}),
      ...(task ? { task } : {}),
      ...(translatedTo ? { translatedTo } : {}),
    },
  });
  // Audio features are independent of the transcript, so they run in parallel
  // rather than lengthening the chain to the first usable clip. A translation
  // re-runs this handler over the same audio and must not redo the analysis.
  if (!translatedTo) {
    await deps.queue.enqueue({ videoId: job.videoId, kind: "AUDIO_FEATURES", payload: { audioKey } });
  }
  return { audioKey, ...(task ? { task } : {}) };
};

interface AudioFeaturePayload {
  audioKey?: string;
  stepMs?: number;
}

/**
 * AUDIO_FEATURES: one loudness / spectral-flatness / silence pass over the
 * extracted audio, cached on the video.
 *
 * This is the signal half of highlight detection — no model, no GPU, and it
 * reuses the WAV that already exists rather than decoding the video again.
 */
export const audioFeaturesHandler: JobHandler<PipelineDeps> = async ({
  job,
  deps,
  signal,
  setProgress,
}) => {
  const payload = (job.payload ?? {}) as AudioFeaturePayload;
  const audioKey = payload.audioKey ?? audioKeyFor(job.videoId);
  const work = jobWorkDir(deps.tempDir, job.id);
  const wav = scratchPath(work, "audio.wav");
  const dump = scratchPath(work, "features.txt");

  await deps.storage.getToFile(audioKey, wav);
  await setProgress(0.3);

  await deps.ffmpeg.audioFeatures(wav, dump, { stepMs: payload.stepMs }, signal);
  await setProgress(0.8);

  // ffmpeg writes no dump when there is nothing to analyse — a silent track, or
  // a video with no audio stream at all. That is a legitimate result, not a
  // failure: yield empty features rather than failing the job and stalling the
  // rest of the chain behind a retry.
  const dumpText = await readFile(dump, "utf8").catch(() => "");
  const features = parseAudioFeatures(dumpText, payload.stepMs ?? 250);
  await deps.videos.setAudioFeatures?.(job.videoId, serializeFeatures(features));

  return {
    windows: features.loudness.length,
    silences: features.silences.length,
    durationMs: features.durationMs,
  };
};

interface VoiceoverPayload {
  voiceoverId?: string;
}

/**
 * VOICEOVER: synthesize the lines a clip's narration needs.
 *
 * Only lines that are new or whose text changed are sent to the provider —
 * moving a clip does not re-synthesize anything, because position is resolved
 * from the anchor at render time rather than baked in here.
 */
export const voiceoverHandler: JobHandler<PipelineDeps> = async ({
  job,
  deps,
  signal,
  setProgress,
}) => {
  const { voiceoverId } = (job.payload ?? {}) as VoiceoverPayload;
  if (!voiceoverId) throw new Error("VOICEOVER job payload is missing voiceoverId");

  const target = await deps.voiceovers.load(voiceoverId);
  if (!target) throw new Error(`voiceover ${voiceoverId} not found`);

  await deps.voiceovers.begin(voiceoverId);
  const work = jobWorkDir(deps.tempDir, job.id);
  try {
    // Build the text to speak, keyed by the anchor it belongs to.
    const wanted = new Map<string, string>();
    if (target.sourceKind === "SCRIPT") {
      // A script has no anchors of its own, so its lines are pinned to evenly
      // spaced points across the clip.
      const parts = (target.script ?? "")
        .split(/\r?\n+/)
        .map((t) => t.trim())
        .filter(Boolean);
      parts.forEach((text, i) => wanted.set(`script:${i}`, text));
    } else {
      const segments = await deps.transcripts.loadSegments(target.videoId);
      segments
        .filter((sg) => sg.endMs > target.startMs && sg.startMs < target.endMs)
        .forEach((sg, i) => {
          const text = sg.text.trim();
          if (text) wanted.set(`seg:${i}`, text);
        });
    }

    const existing = parseLines(target.linesJson);
    const stale = new Set(staleLines(existing, wanted).map((l) => l.ref));
    // Keep what is still valid; drop lines whose anchor no longer exists.
    const kept = existing.filter((l) => wanted.has(l.ref) && !stale.has(l.ref));
    const todo = [...wanted.entries()].filter(([ref]) => !kept.some((l) => l.ref === ref));

    const lines: VoiceLine[] = [...kept];
    let done = 0;
    for (const [ref, text] of todo) {
      const out = scratchPath(work, `vo-${ref.replace(/[^\w]/g, "_")}.wav`);
      const result = await deps.tts.synthesize(text, out, {
        voiceId: target.voiceId || undefined,
        language: target.language,
        speed: target.speed,
        signal,
      });
      const key = `voiceovers/${voiceoverId}/${ref.replace(/[^\w]/g, "_")}.wav`;
      await deps.storage.putFile(key, result.audioPath, "audio/wav");
      lines.push({ ref, text, durationMs: result.durationMs, audioKey: key });
      done++;
      await setProgress(todo.length ? 0.1 + (done / todo.length) * 0.85 : 0.95);
    }

    lines.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
    await deps.voiceovers.complete(voiceoverId, serializeLines(lines));
    return { lines: lines.length, synthesized: todo.length, reused: kept.length };
  } catch (err) {
    await deps.voiceovers.fail(voiceoverId, err instanceof Error ? err.message : String(err));
    throw err;
  }
};

interface WorkerRunPayload {
  runId?: string;
  minClipMs?: number;
  maxClipMs?: number;
  maxClips?: number;
}

/**
 * WORKER_RUN: produce reviewable suggestions for a video.
 *
 * Nothing here changes the project. It gathers the transcript candidates from
 * whichever AnalysisProvider is configured, fuses them with the cached audio
 * features, and writes proposals for a human to accept or reject — which is
 * also what makes the accept/reject signal worth learning from later.
 */
export const workerRunHandler: JobHandler<PipelineDeps> = async ({
  job,
  deps,
  signal,
  setProgress,
}) => {
  const payload = (job.payload ?? {}) as WorkerRunPayload;
  const { runId } = payload;
  if (!runId) throw new Error("WORKER_RUN job payload is missing runId");

  const run = await deps.workers.loadRun(runId);
  if (!run) throw new Error(`worker run ${runId} not found`);

  await deps.workers.begin(runId);
  try {
    const segments = await deps.transcripts.loadSegments(run.videoId);
    await setProgress(0.3);

    // The learned style biases the *request* as well as the ranking: asking for
    // 60s candidates from an editor who always cuts 20s wastes the provider's
    // attention on windows they will never accept.
    const profile = parseProfile(run.profileJson);
    const bias = clipLengthBias(profile, {
      minClipMs: payload.minClipMs ?? 15_000,
      maxClipMs: payload.maxClipMs ?? 60_000,
    });

    // Reuse the configured analysis provider rather than scoring transcripts a
    // second way here — two rankings would drift apart.
    const minClipMs = payload.minClipMs ?? bias.minClipMs;
    const maxClipMs = payload.maxClipMs ?? bias.maxClipMs;
    const candidates =
      segments.length > 0
        ? await deps.analysis.suggestClips(segments, {
            minClipMs,
            maxClipMs,
            maxClips: payload.maxClips ?? 8,
            signal,
          })
        : [];
    await setProgress(0.7);

    const drafts = buildSuggestions({
      candidates,
      features: parseStoredFeatures(run.audioFeatureJson),
      objectives: run.objectives ?? undefined,
      maxHighlights: payload.maxClips ?? 8,
      profile,
    });

    const written = await deps.workers.complete(
      runId,
      drafts.map((d) => ({
        kind: d.kind,
        startMs: d.startMs,
        endMs: d.endMs,
        score: d.score,
        reason: d.reason,
        payloadJson: { signals: d.signals, ...(d.payload ?? {}) },
      })),
    );
    return {
      suggestions: written,
      candidates: candidates.length,
      profileApplied: bias.learned,
      contentType: run.contentType,
    };
  } catch (err) {
    await deps.workers.fail(runId, err instanceof Error ? err.message : String(err));
    throw err;
  }
};

interface TranscribePayload {
  audioKey?: string;
  language?: string;
  diarize?: boolean;
  task?: "transcribe" | "translate";
  /** Non-empty means this run produces a translation, stored alongside the
   *  source transcript rather than replacing it, and skips status/ANALYZE. */
  translatedTo?: string;
}

/** TRANSCRIBE: run the transcription provider, persist segments + words. */
export const transcribeHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const payload = (job.payload ?? {}) as TranscribePayload;
  const audioKey = payload.audioKey ?? audioKeyFor(job.videoId);
  const isTranslation = !!payload.translatedTo;
  const wav = scratchPath(jobWorkDir(deps.tempDir, job.id), "audio.wav");
  await deps.storage.getToFile(audioKey, wav);

  // A translation is a side artefact — leave the video READY and its clips
  // alone while it builds.
  if (!isTranslation) await deps.videos.setStatus(job.videoId, "TRANSCRIBING");
  await setProgress(0.2);

  const video = await deps.videos.get(job.videoId);
  const vocabulary = await Promise.resolve(deps.videos.transcriptionTerms?.(job.videoId) ?? []).catch(() => []);
  let lastPct = -1;
  let jobFraction = 0.2;
  let lastBeat = 0;
  const result = await deps.transcription.transcribe(wav, {
    language: payload.language,
    task: payload.task,
    ...(vocabulary.length ? { vocabulary } : {}),
    diarize: payload.diarize,
    wordTimestamps: true,
    signal,
    durationMs: video?.durationMs ?? undefined,
    // Decoding 0..1 occupies 0.2..0.9 of the job; saving takes the rest.
    onProgress: (f) => {
      jobFraction = 0.2 + f * 0.7;
      const pct = Math.floor(f * 100);
      if (pct > lastPct) {
        lastPct = pct;
        void setProgress(jobFraction).catch(() => {});
      }
    },
    // Touch the row on any output so a slow chunk doesn't look like a dead worker.
    onActivity: () => {
      const now = Date.now();
      if (now - lastBeat > 10_000) {
        lastBeat = now;
        void setProgress(jobFraction).catch(() => {});
      }
    },
  });
  const { segmentCount } = await deps.transcripts.save(job.videoId, result, {
    translatedTo: payload.translatedTo ?? "",
  });
  await setProgress(0.9);

  if (isTranslation) {
    return { segmentCount, translatedTo: payload.translatedTo, language: result.language };
  }
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
  if (segments.length === 0) {
    // A recording with no discernible speech (silence, music, ambient PC audio)
    // transcribes to nothing — that's a valid outcome, not a failure. The video
    // is already READY; there's just nothing to suggest clips from.
    return { clipCount: 0, consideredSegments: 0, note: "no speech detected" };
  }

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
  if (clipCount > 0) {
    await deps.queue.enqueue({ videoId: job.videoId, kind: "THUMBNAIL" });
  }
  return { clipCount, consideredSegments: segments.length };
};

interface ThumbnailPayload {
  clipId?: string;
}

/**
 * THUMBNAIL: grab a poster frame at each clip's midpoint, plus one poster for the
 * video itself (used in the library / rails). Last ingest step.
 *
 * A full run (no `clipId`) does the video poster too, but only when the video
 * has none yet — so re-running is cheap and idempotent. A single-clip run
 * (re-thumbnail while editing) skips the video poster.
 */
export const thumbnailHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const { clipId } = (job.payload ?? {}) as ThumbnailPayload;

  const targets = clipId
    ? [await deps.thumbnails.target(clipId)].filter((t): t is NonNullable<typeof t> => t !== null)
    : await deps.thumbnails.targetsForVideo(job.videoId);

  const poster = clipId ? null : await deps.thumbnails.videoPosterTarget(job.videoId);
  const needPoster = !!poster && !poster.hasThumbnail;

  if (targets.length === 0 && !needPoster) return { generated: 0 };

  const sourceKey = targets[0]?.sourceKey ?? poster?.sourceKey;
  if (!sourceKey) return { generated: 0 };
  const source = await deps.source.ensureLocal(job.videoId, sourceKey, signal);
  const work = jobWorkDir(deps.tempDir, job.id);

  // Audio-only sources (e.g. a mic-only live recording) have no frame to grab —
  // ffmpeg would just error with "Output file does not contain any stream".
  const probe = await deps.ffmpeg.probe(source, signal).catch(() => null);
  if (probe && probe.videoCodec === null && probe.width === null) {
    if (!clipId) await deps.source.evict(job.videoId);
    return { generated: 0, skipped: "no video stream" };
  }

  let generated = 0;
  const total = targets.length + (needPoster ? 1 : 0);
  try {
    if (needPoster && poster) {
      // A frame a little into the video — 25%, clamped away from the very end.
      const dur = poster.durationMs ?? 0;
      const atMs = dur > 0 ? Math.min(Math.floor(dur * 0.25), Math.max(0, dur - 500)) : 3000;
      const out = scratchPath(work, `poster.jpg`);
      await deps.ffmpeg.thumbnail(source, out, { atMs, width: 640 }, signal);

      const key = `videos/${job.videoId}/poster.jpg`;
      await deps.storage.putFile(key, out, "image/jpeg");
      await deps.thumbnails.setVideoKey(job.videoId, key);

      generated++;
      await setProgress(generated / total);
    }

    for (const t of targets) {
      const atMs = t.startMs + Math.floor((t.endMs - t.startMs) / 2);
      const out = scratchPath(work, `${t.clipId}.jpg`);
      await deps.ffmpeg.thumbnail(source, out, { atMs, width: 640 }, signal);

      const key = `clips/${t.clipId}/thumb.jpg`;
      await deps.storage.putFile(key, out, "image/jpeg");
      await deps.thumbnails.setKey(t.clipId, key);

      generated++;
      await setProgress(generated / total);
    }
  } finally {
    // Ingest is done — drop the cached source unless one clip was targeted
    // (a re-thumbnail, likely mid-editing, with a render probably next).
    if (!clipId) await deps.source.evict(job.videoId);
  }
  return { generated };
};

interface RenderPayload {
  renderId: string;
}

const CRF_BY_QUALITY: Record<string, number> = { ORIGINAL: 16, P1080: 20, P720: 24 };

/** RENDER: cut → reframe to aspect → burn captions (ffmpeg SRT or Remotion) → upload. */
export const renderHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const { renderId } = (job.payload ?? {}) as RenderPayload;
  if (!renderId) throw new Error("RENDER job payload is missing renderId");

  const target = await deps.renders.loadTarget(renderId);
  if (!target) throw new Error(`render ${renderId} not found`);

  await deps.renders.begin(renderId);

  const work = jobWorkDir(deps.tempDir, job.id);
  try {
    const source = await deps.source.ensureLocal(target.videoId, target.sourceKey, signal);
    const cut = scratchPath(work, "cut.mp4");
    const censored = scratchPath(work, "censored.mp4");
    const narrated = scratchPath(work, "narrated.mp4");
    const reframed = scratchPath(work, "reframed.mp4");
    const captioned = scratchPath(work, "captioned.mp4");
    await setProgress(0.2);

    await deps.ffmpeg.cut(
      source,
      cut,
      { startMs: target.startMs, endMs: target.endMs, crf: CRF_BY_QUALITY[target.quality] ?? 20 },
      signal,
    );
    await setProgress(0.45);

    // The clip's own words. Censoring needs them even when captions are off,
    // because the bleep is driven by the transcript either way.
    // `id` is carried so per-occurrence censor overrides can match; masking
    // preserves it, and buildCues ignores it.
    let words: Array<{ id?: string; text: string; startMs: number; endMs: number }> = [];
    // Words are needed whenever the censor pass has anything to do — which
    // includes a clip with detection off but occurrences ticked by hand.
    const censorCfg = {
      enabled: target.censor.enabled,
      sensitivity: target.censor.sensitivity,
      allowList: target.censor.allowList,
      denyList: target.censor.denyList,
      exemptWordIds: target.censor.exemptWordIds,
      censorWordIds: target.censor.forceWordIds,
      audioEnabled: target.censor.audioEnabled,
      audioExemptWordIds: target.censor.audioExemptWordIds,
      audioForceWordIds: target.censor.audioForceWordIds,
      wordOverrides: parseWordOverrides(target.censor.wordOverridesJson),
    };
    const censoring = censorHasWork(censorCfg);

    if (target.burnCaptions || censoring) {
      const segments = await deps.transcripts.loadSegments(target.videoId);
      words = segments
        .flatMap((s) => s.words)
        .filter((w) => w.startMs >= target.startMs && w.endMs <= target.endMs);
    }

    // Censor the audio on the cut clip, before anything else touches it: every
    // later pass carries audio through with `-c:a copy`, so doing it here means
    // the bleep survives reframing, captioning and compositing untouched.
    let staged = cut;
    // The audio half is separately switchable, clip-wide and per occurrence:
    // a word left out here is still masked in the captions below, its speech is
    // simply left audible.
    if (censorHasAudioWork(censorCfg) && words.length > 0) {
      const spans = audioSpans(words, censorCfg);
      if (spans.length > 0) {
        await deps.ffmpeg.censorAudio(
          cut,
          censored,
          {
            // Word times are absolute; the cut clip starts at zero.
            spans: spans.map((sp) => ({
              startSec: Math.max(0, sp.startMs - target.startMs) / 1000,
              endSec: Math.max(0, sp.endMs - target.startMs) / 1000,
              // Absent leaves the clip's own mode in charge.
              ...(sp.audioMode ? { mode: sp.audioMode } : {}),
            })),
            mode: target.censor.audioMode,
          },
          signal,
        );
        staged = censored;
      }
    }

    // Mix the voiceover onto the same staged audio, after censoring so the
    // narration is never bleeped and before the reframe so `-c:a copy` carries
    // it through everything downstream.
    if (target.voiceover) {
      // `clipMs` is declared further down with the reframe logic; the voiceover
      // pass runs before it, so derive the length here.
      const voClipMs = target.endMs - target.startMs;
      const stored = parseLines(target.voiceover.linesJson);
      if (stored.length > 0) {
        const segments = await deps.transcripts.loadSegments(target.videoId);
        // Anchors are resolved *now*, from the clip's current timing — that is
        // what lets an edit move the narration without re-synthesizing it.
        const anchors = segments
          .filter((sg) => sg.endMs > target.startMs && sg.startMs < target.endMs)
          .map((sg, i) => ({
            ref: `seg:${i}`,
            startMs: Math.max(0, sg.startMs - target.startMs),
            endMs: Math.max(0, sg.endMs - target.startMs),
          }));
        const scriptAnchors = stored
          .filter((l) => l.ref.startsWith("script:"))
          .map((l, i, all) => {
            const step = voClipMs / Math.max(1, all.length);
            return { ref: l.ref, startMs: Math.round(i * step), endMs: Math.round((i + 1) * step) };
          });

        const placed = placeLines(stored, [...anchors, ...scriptAnchors], { durationMs: voClipMs });
        if (placed.length > 0) {
          const files = await Promise.all(
            placed.map(async (p, i) => {
              const local = scratchPath(work, `voline-${i}.wav`);
              await mkdir(dirname(local), { recursive: true });
              await deps.storage.getToFile(p.audioKey, local);
              return { path: local, startMs: p.startMs, tempo: p.tempo, playedMs: p.playedMs };
            }),
          );
          await deps.ffmpeg.mixVoiceover(
            staged,
            narrated,
            { lines: files, duckDb: target.voiceover.duckDb },
            signal,
          );
          staged = narrated;
        }
      }
    }

    // Mask the caption text for the same words the audio bleeped.
    if (censoring && words.length > 0) {
      const flagged = censoredIndices(words, censorCfg);
      // A word can carry its own caption mode, so the mask is resolved per
      // index rather than once for the clip.
      const perWord = new Map<number, { mode?: CaptionCensorMode; replacement?: string | null }>();
      for (const index of flagged) {
        const id = words[index]?.id;
        const own = id ? censorCfg.wordOverrides[id] : undefined;
        if (own?.captionMode || own?.replacement != null) {
          perWord.set(index, { mode: own.captionMode, replacement: own.replacement });
        }
      }
      words = maskWords(
        words,
        flagged,
        target.censor.captionMode,
        target.censor.replacement ?? undefined,
        perWord,
      );
    }
    // Captions off: the words were only loaded to drive the bleep.
    if (!target.burnCaptions) words = [];
    // Rich style (gradient / glow / glass / effect layers) or a real animation
    // routes through Remotion; a plain scalar style burns statically with ffmpeg.
    const animated =
      words.length > 0 && captionNeedsRemotion(target.captionAnimation, target.textStyle);
    const staticBurn = words.length > 0 && !animated;
    const hasTextOverlays = target.textOverlays.length > 0;

    // The same tier decision for image layers. The ffmpeg `overlay` filter can
    // place and fade a still, but it has no rotation and no per-frame scale, so
    // anything it cannot express is composited by Remotion and the rest stay on
    // the cheap path.
    const overlayNeedsRemotion = (o: RenderOverlay) => o.animationJson !== null || o.rotation !== 0;
    const movingOverlays = target.overlays.filter(overlayNeedsRemotion);
    const staticOverlays = target.overlays.filter((o) => !overlayNeedsRemotion(o));

    // Static captions burn during the reframe; animated ones are composited by
    // Remotion afterwards, so the reframe gets no subtitle path.
    let subtitlePath: string | undefined;
    let subtitleStyle: CaptionBurnStyle | undefined;
    if (staticBurn) {
      subtitlePath = scratchPath(work, "captions.srt");
      await mkdir(dirname(subtitlePath), { recursive: true });
      const cues = buildCues(words);
      const srt = Object.keys(target.wordStyles).length
        ? toStyledSrt(cues, target.startMs, target.wordStyles)
        : toSrt(cues, target.startMs);
      await writeFile(subtitlePath, srt, "utf8");
      const cs = target.captionStyle ?? DEFAULT_CAPTION_STYLE;
      subtitleStyle = {
        fontName: cs.fontFamily,
        fontSizePx: cs.fontSizePx,
        fontWeight: cs.fontWeight,
        textColor: cs.textColor,
        outlineColor: cs.outlineColor,
        outlineWidthPx: cs.outlineWidthPx,
        backgroundColor: cs.backgroundColor,
        alignment: cs.alignment,
        positionY: cs.positionY,
      };
    }

    const aspect = toAspectPreset(target.aspectRatio);
    const clipMs = target.endMs - target.startMs;
    // An authored capture window reframes even a 16:9 clip — the user asked for
    // a punch-in, not an aspect change.
    const focusWindow = parseFocusTrack(target.focusTrackJson);
    const hasWindow = focusWindow.length > 0;
    const needsReframe =
      aspect !== "16:9" || subtitlePath !== undefined || animated || hasWindow;

    // Crop strategy, widest to narrowest: an authored window, then a manual
    // focal point, then a detected face. Only the last one costs a detection
    // pass, so it runs only when nothing more specific exists.
    let focalTrack: FocalPoint[] = [];
    if (
      needsReframe &&
      !hasWindow &&
      target.focalX === null &&
      target.focalY === null &&
      aspect !== "16:9"
    ) {
      const pre = await deps.ffmpeg.probe(staged, signal);
      const raw = await deps.faces.detectTrack(staged, {
        durationMs: clipMs,
        width: pre.width ?? undefined,
        height: pre.height ?? undefined,
        signal,
      });
      focalTrack = resampleTrack(raw, clipMs);
    }
    const tracked = focalTrack.length >= 2;

    if (needsReframe && hasWindow && focusNeedsZoom(focusWindow)) {
      // Zoom means the window changes size, which `crop` cannot express.
      const pre = await deps.ffmpeg.probe(staged, signal);
      await deps.ffmpeg.reframeZoom(
        staged,
        reframed,
        {
          aspect,
          samples: focusToSamples(focusWindow, clipMs),
          fps: pre.fps ?? 30,
          subtitlePath,
          subtitleStyle,
        },
        signal,
      );
    } else if (needsReframe && hasWindow) {
      // Pan-only: flatten to a focal track and reuse the cheaper crop path.
      await deps.ffmpeg.reframeTracked(
        staged,
        reframed,
        { aspect, track: focusToFocalTrack(focusWindow, clipMs), subtitlePath, subtitleStyle },
        signal,
      );
    } else if (needsReframe && tracked) {
      await deps.ffmpeg.reframeTracked(
        staged,
        reframed,
        { aspect, track: focalTrack, subtitlePath, subtitleStyle },
        signal,
      );
    } else if (needsReframe) {
      await deps.ffmpeg.reframe(
        staged,
        reframed,
        {
          aspect,
          focalX: target.focalX ?? undefined,
          focalY: target.focalY ?? undefined,
          subtitlePath,
          subtitleStyle,
        },
        signal,
      );
    }
    await setProgress(0.7);

    let output = needsReframe ? reframed : staged;

    // Fetch the bytes for layers Remotion composites before it runs.
    const movingLayers = await Promise.all(
      movingOverlays.map(async (o, i) => {
        const local = scratchPath(work, `moving-${i}.${o.animated ? "gif" : "png"}`);
        await mkdir(dirname(local), { recursive: true });
        await deps.storage.getToFile(o.storageKey, local);
        return { ...o, path: local };
      }),
    );

    if (animated || hasTextOverlays || movingLayers.length > 0) {
      const { width, height } = ASPECT_DIMENSIONS[aspect];
      const pre = await deps.ffmpeg.probe(output, signal);
      await deps.captions.renderCaptioned({
        videoPath: output,
        outputPath: captioned,
        cues: animated ? buildCues(words) : [],
        preset: remotionPreset(target.captionAnimation),
        style: target.captionStyle ?? DEFAULT_CAPTION_STYLE,
        textStyle: target.textStyle,
        wordRules: target.wordRules,
        textOverlays: target.textOverlays,
        imageOverlays: movingLayers,
        width: pre.width ?? width,
        height: pre.height ?? height,
        fps: pre.fps ?? 30,
        durationMs: target.endMs - target.startMs,
        signal,
      });
      output = captioned;
    }
    if (staticOverlays.length > 0) {
      const pre = await deps.ffmpeg.probe(output, signal);
      const overlaid = scratchPath(work, "overlaid.mp4");
      const items = await Promise.all(
        staticOverlays.map(async (o, i) => {
          const ext = o.animated ? "gif" : "png";
          const local = scratchPath(work, `overlay-${i}.${ext}`);
          await mkdir(dirname(local), { recursive: true });
          await deps.storage.getToFile(o.storageKey, local);
          return {
            path: local,
            x: o.x,
            y: o.y,
            scale: o.scale,
            opacity: o.opacity,
            startSec: o.startMs === null ? null : o.startMs / 1000,
            endSec: o.endMs === null ? null : o.endMs / 1000,
            loop: o.animated,
          };
        }),
      );
      await deps.ffmpeg.composeOverlays(
        output,
        overlaid,
        { frameWidth: pre.width ?? 1080, items },
        signal,
      );
      output = overlaid;
    }
    await setProgress(0.9);

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
  } finally {
    await deps.source.evict(target.videoId);
  }
};
