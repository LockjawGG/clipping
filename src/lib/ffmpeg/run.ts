import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import {
  ASPECT_DIMENSIONS,
  type AspectRatio,
  type CaptionBurnStyle,
  type OverlayCompositeItem,
  buildConcatArgs,
  buildToneWavArgs,
  buildVideoLayerArgs,
  buildCutArgs,
  concatListLine,
  buildExtractAudioArgs,
  buildOverlayCompositeArgs,
  buildProbeArgs,
  buildReframeArgs,
  buildRemuxArgs,
  buildTranscodeAvArgs,
  buildVideoPacketDtsArgs,
  buildThumbnailArgs,
  buildTrackedReframeArgs,
  buildZoomReframeArgs,
  buildAudioFeatureArgs,
  buildCensorAudioArgs,
  buildVoiceoverMixArgs,
  type VoiceoverLinePlacement,
  type AudioCensorMode,
  type CensorSpanSec,
} from "./args.ts";
import type { FocalPoint } from "../faces/track.ts";
import type { FocusSample } from "../focus/keyframes.ts";
import { focalTrackToCropExpr, focusToZoompanExpr } from "./track-crop.ts";

const execFileAsync = promisify(execFile);

/**
 * Windows-only: pip/winget console shims (`ffmpeg.exe`, `ffprobe.exe`) sporadically
 * fail to spawn from a non-console Node process with STATUS_DLL_INIT_FAILED and
 * friends. A quick retry almost always clears it. Same set the whisper runner uses.
 */
const FLAKY_SPAWN_EXIT = new Set([3221225794, 3221225781, 3221225595]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MediaInfo {
  durationMs: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  audioChannels: number | null;
  sampleRate: number | null;
  sizeBytes: number | null;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
}

interface ProbeJson {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string };
}

function toNumberOrNull(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse an "num/den" rational (ffprobe frame rates), rounded to 3 dp. */
function parseRational(value: string | undefined): number | null {
  if (!value) return null;
  const [n, d] = value.split("/").map(Number);
  if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) {
    return Math.round((n / d) * 1000) / 1000;
  }
  return toNumberOrNull(value);
}

/** ffprobe `-show_format -show_streams` JSON → normalised MediaInfo. Pure. */
export function parseProbeOutput(raw: unknown): MediaInfo {
  const json = (raw ?? {}) as ProbeJson;
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  const durationSec =
    toNumberOrNull(json.format?.duration) ?? toNumberOrNull(video?.duration) ?? toNumberOrNull(audio?.duration) ?? 0;

  return {
    durationMs: Math.max(0, Math.round(durationSec * 1000)),
    width: toNumberOrNull(video?.width),
    height: toNumberOrNull(video?.height),
    fps: parseRational(video?.r_frame_rate) ?? parseRational(video?.avg_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    audioChannels: toNumberOrNull(audio?.channels),
    sampleRate: toNumberOrNull(audio?.sample_rate),
    sizeBytes: toNumberOrNull(json.format?.size),
  };
}

export interface CutOptions {
  startMs: number;
  endMs: number;
  crf?: number;
  /** Force a common frame size / rate — see `buildCutArgs`. */
  normalizeTo?: { width: number; height: number; fps: number };
}

export interface ReframeOptions {
  aspect: AspectRatio;
  focalX?: number;
  focalY?: number;
  subtitlePath?: string;
  subtitleStyle?: CaptionBurnStyle;
  blurredBackground?: boolean;
}

export interface ThumbnailOptions {
  atMs: number;
  width?: number;
}

export interface TrackedReframeOptions {
  aspect: AspectRatio;
  /** Smoothed/resampled focal-point keyframes; 2+ points. */
  track: FocalPoint[];
  subtitlePath?: string;
  subtitleStyle?: CaptionBurnStyle;
}

/** A reframe whose capture window also zooms — `crop` cannot change size. */
export interface ZoomReframeOptions {
  aspect: AspectRatio;
  /** Dense window samples (position + zoom) from `focusToSamples`. */
  samples: (FocusSample & { atMs: number })[];
  /** Output frame rate; zoompan expressions read `on/fps` for elapsed time. */
  fps: number;
  subtitlePath?: string;
  subtitleStyle?: CaptionBurnStyle;
}

/** Bleep / mute windows over the clip's audio; video is copied untouched. */
export interface CensorAudioOptions {
  spans: CensorSpanSec[];
  mode: AudioCensorMode;
}

/** Voiceover lines to mix over a clip's own audio. */
export interface VoiceoverMixOptions {
  lines: VoiceoverLinePlacement[];
  duckDb?: number;
}

export interface OverlayCompositeOptions {
  /** Frame width of `inputPath`; overlay sizes scale off it. */
  frameWidth: number;
  items: OverlayCompositeItem[];
}

/** The ffmpeg operations the pipeline needs. Fakeable in tests. */
export interface Ffmpeg {
  probe(inputPath: string, signal?: AbortSignal): Promise<MediaInfo>;
  extractAudio(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void>;
  /** Rewrite a container (stream copy) to fix timestamps / add a seek index. */
  remux(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void>;
  /** Re-encode to H.264/AAC at a constant frame rate, rebuilding the timeline. */
  transcodeAv(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void>;
  /**
   * Count video packets whose decode timestamp doesn't advance. Non-zero means
   * a player can't seek the file reliably. Reads packets only — no decoding.
   */
  videoTimestampReport(
    inputPath: string,
    signal?: AbortSignal,
  ): Promise<{ packets: number; backwards: number; duplicateRun: number }>;
  /** Frame-accurate trim (re-encode, never stream-copy). */
  cut(inputPath: string, outputPath: string, opts: CutOptions, signal?: AbortSignal): Promise<void>;
  /** Lay pre-cut pieces from upper lanes over a base video. */
  layerVideo(
    inputPath: string,
    outputPath: string,
    opts: { layers: Array<{ path: string; startSec: number }>; width: number; height: number; crf?: number },
    signal?: AbortSignal,
  ): Promise<void>;
  /** Write a bleep tone as a standalone WAV, for splicing into speech. */
  toneWav(
    outputPath: string,
    opts: { durationMs: number; sampleRate: number; hz?: number; gain?: number },
    signal?: AbortSignal,
  ): Promise<void>;
  /** Join pre-cut pieces end to end, in the order given. */
  concat(
    pieces: readonly string[],
    outputPath: string,
    opts: { reencode?: boolean; crf?: number },
    signal?: AbortSignal,
  ): Promise<void>;
  /** Scale/crop to an aspect preset, optionally burning subtitles. */
  reframe(inputPath: string, outputPath: string, opts: ReframeOptions, signal?: AbortSignal): Promise<void>;
  /** Reframe with a crop window that pans along a focal-point track. */
  reframeTracked(
    inputPath: string,
    outputPath: string,
    opts: TrackedReframeOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Reframe with a capture window that pans *and* zooms. */
  reframeZoom(
    inputPath: string,
    outputPath: string,
    opts: ZoomReframeOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  /** One loudness / flatness / silence pass; writes a metadata dump. */
  audioFeatures(
    inputPath: string,
    metadataPath: string,
    opts?: { stepMs?: number },
    signal?: AbortSignal,
  ): Promise<void>;
  /** Mix synthesized voiceover lines over the clip's audio. */
  mixVoiceover(
    inputPath: string,
    outputPath: string,
    opts: VoiceoverMixOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Bleep / mute the audio inside a set of windows. */
  censorAudio(
    inputPath: string,
    outputPath: string,
    opts: CensorAudioOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Grab a single frame as a JPEG. */
  thumbnail(inputPath: string, outputPath: string, opts: ThumbnailOptions, signal?: AbortSignal): Promise<void>;
  /** Composite library images/GIFs onto the video, each within its time window. */
  composeOverlays(
    inputPath: string,
    outputPath: string,
    opts: OverlayCompositeOptions,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface FfmpegRunnerOptions {
  ffmpegPath: string;
  ffprobePath: string;
  maxBufferBytes?: number;
}

/**
 * Runs the argv arrays from `args.ts` through the real binaries with
 * `shell: false`. On a non-zero exit the rejection carries the tail of stderr.
 */
export class FfmpegRunner implements Ffmpeg {
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly maxBuffer: number;

  constructor(opts: FfmpegRunnerOptions) {
    this.ffmpegPath = opts.ffmpegPath;
    this.ffprobePath = opts.ffprobePath;
    this.maxBuffer = opts.maxBufferBytes ?? 16 * 1024 * 1024;
  }

  async probe(inputPath: string, signal?: AbortSignal): Promise<MediaInfo> {
    const { stdout } = await this.exec(this.ffprobePath, buildProbeArgs({ inputPath }), signal);
    return parseProbeOutput(JSON.parse(stdout));
  }

  async extractAudio(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(this.ffmpegPath, buildExtractAudioArgs({ inputPath, outputPath }), signal);
  }

  async remux(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(this.ffmpegPath, buildRemuxArgs({ inputPath, outputPath }), signal);
  }

  async transcodeAv(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(this.ffmpegPath, buildTranscodeAvArgs({ inputPath, outputPath }), signal);
  }

  async videoTimestampReport(
    inputPath: string,
    signal?: AbortSignal,
  ): Promise<{ packets: number; backwards: number; duplicateRun: number }> {
    const { stdout } = await this.exec(
      this.ffprobePath,
      buildVideoPacketDtsArgs({ inputPath }),
      signal,
    );
    let packets = 0;
    let backwards = 0;
    let duplicateRun = 0;
    let run = 1;
    let prev = Number.NEGATIVE_INFINITY;
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (t === "") continue;
      packets++;
      const dts = Number(t); // "N/A" -> NaN, a packet with no DTS
      if (!Number.isFinite(dts) || dts < prev) {
        backwards++;
      } else if (dts === prev) {
        run += 1;
        if (run > duplicateRun) duplicateRun = run;
      } else {
        run = 1;
      }
      if (Number.isFinite(dts)) prev = dts;
    }
    return { packets, backwards, duplicateRun };
  }


  async layerVideo(
    inputPath: string,
    outputPath: string,
    opts: { layers: Array<{ path: string; startSec: number }>; width: number; height: number; crf?: number },
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(this.ffmpegPath, buildVideoLayerArgs({ inputPath, outputPath, ...opts }), signal);
  }

  async toneWav(
    outputPath: string,
    opts: { durationMs: number; sampleRate: number; hz?: number; gain?: number },
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(this.ffmpegPath, buildToneWavArgs({ outputPath, ...opts }), signal);
  }

  async concat(
    pieces: readonly string[],
    outputPath: string,
    opts: { reencode?: boolean; crf?: number } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    if (pieces.length === 0) throw new Error("nothing to concat");
    await mkdir(dirname(outputPath), { recursive: true });
    // The list lives beside the output so it is cleaned up with the job's
    // scratch dir, and holds absolute paths, which is why -safe 0 is required.
    const listPath = `${outputPath}.concat.txt`;
    await writeFile(listPath, pieces.map(concatListLine).join("\n") + "\n", "utf8");
    try {
      await this.exec(
        this.ffmpegPath,
        buildConcatArgs({ listPath, outputPath, reencode: opts.reencode, crf: opts.crf }),
        signal,
      );
    } finally {
      await rm(listPath, { force: true }).catch(() => {});
    }
  }

  async cut(inputPath: string, outputPath: string, opts: CutOptions, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(
      this.ffmpegPath,
      buildCutArgs({
        inputPath,
        outputPath,
        startMs: opts.startMs,
        endMs: opts.endMs,
        crf: opts.crf,
        normalizeTo: opts.normalizeTo,
      }),
      signal,
    );
  }

  async reframe(
    inputPath: string,
    outputPath: string,
    opts: ReframeOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(this.ffmpegPath, buildReframeArgs({ inputPath, outputPath, ...opts }), signal);
  }

  async audioFeatures(
    inputPath: string,
    metadataPath: string,
    opts: { stepMs?: number } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(metadataPath), { recursive: true });
    await this.exec(
      this.ffmpegPath,
      buildAudioFeatureArgs({ inputPath, metadataPath, stepMs: opts.stepMs }),
      signal,
    );
  }

  async mixVoiceover(
    inputPath: string,
    outputPath: string,
    opts: VoiceoverMixOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(
      this.ffmpegPath,
      buildVoiceoverMixArgs({ inputPath, outputPath, lines: opts.lines, duckDb: opts.duckDb }),
      signal,
    );
  }

  async censorAudio(
    inputPath: string,
    outputPath: string,
    opts: CensorAudioOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(
      this.ffmpegPath,
      buildCensorAudioArgs({ inputPath, outputPath, spans: opts.spans, mode: opts.mode }),
      signal,
    );
  }

  async reframeZoom(
    inputPath: string,
    outputPath: string,
    opts: ZoomReframeOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    const { width, height } = ASPECT_DIMENSIONS[opts.aspect];
    const { z, x, y } = focusToZoompanExpr(opts.samples, { width, height, fps: opts.fps });
    await this.exec(
      this.ffmpegPath,
      buildZoomReframeArgs({
        inputPath,
        outputPath,
        aspect: opts.aspect,
        zoomZ: z,
        zoomX: x,
        zoomY: y,
        fps: opts.fps,
        subtitlePath: opts.subtitlePath,
        subtitleStyle: opts.subtitleStyle,
      }),
      signal,
    );
  }

  async reframeTracked(
    inputPath: string,
    outputPath: string,
    opts: TrackedReframeOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    const { width, height } = ASPECT_DIMENSIONS[opts.aspect];
    const { x, y } = focalTrackToCropExpr(opts.track, { width, height });
    await this.exec(
      this.ffmpegPath,
      buildTrackedReframeArgs({
        inputPath,
        outputPath,
        aspect: opts.aspect,
        cropX: x,
        cropY: y,
        subtitlePath: opts.subtitlePath,
        subtitleStyle: opts.subtitleStyle,
      }),
      signal,
    );
  }

  async thumbnail(
    inputPath: string,
    outputPath: string,
    opts: ThumbnailOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(
      this.ffmpegPath,
      buildThumbnailArgs({ inputPath, outputPath, atMs: opts.atMs, width: opts.width }),
      signal,
    );
  }

  async composeOverlays(
    inputPath: string,
    outputPath: string,
    opts: OverlayCompositeOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(
      this.ffmpegPath,
      buildOverlayCompositeArgs({
        inputPath,
        outputPath,
        frameWidth: opts.frameWidth,
        items: opts.items,
      }),
      signal,
    );
  }

  private async exec(bin: string, args: string[], signal?: AbortSignal) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await execFileAsync(bin, args, { signal, maxBuffer: this.maxBuffer });
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        if (e.code === "ENOENT") {
          throw new Error(`ffmpeg binary not found: ${bin} (set FFMPEG_PATH / FFPROBE_PATH)`);
        }
        const flakySpawn =
          typeof e.code === "number" && FLAKY_SPAWN_EXIT.has(e.code) && !e.stderr;
        if (flakySpawn && attempt < 4 && !signal?.aborted) {
          await sleep(150 * attempt);
          continue;
        }
        const tail = (e.stderr ?? "").split("\n").slice(-4).join("\n").trim();
        throw new Error(`${bin} failed (${e.code ?? "?"})${tail ? `:\n${tail}` : ""}`);
      }
    }
  }
}
