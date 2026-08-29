import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import {
  ASPECT_DIMENSIONS,
  type AspectRatio,
  type CaptionBurnStyle,
  type OverlayCompositeItem,
  buildCutArgs,
  buildExtractAudioArgs,
  buildOverlayCompositeArgs,
  buildProbeArgs,
  buildReframeArgs,
  buildRemuxArgs,
  buildTranscodeAvArgs,
  buildVideoPacketDtsArgs,
  buildThumbnailArgs,
  buildTrackedReframeArgs,
} from "./args.ts";
import type { FocalPoint } from "../faces/track.ts";
import { focalTrackToCropExpr } from "./track-crop.ts";

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
  ): Promise<{ packets: number; nonMonotonic: number }>;
  /** Frame-accurate trim (re-encode, never stream-copy). */
  cut(inputPath: string, outputPath: string, opts: CutOptions, signal?: AbortSignal): Promise<void>;
  /** Scale/crop to an aspect preset, optionally burning subtitles. */
  reframe(inputPath: string, outputPath: string, opts: ReframeOptions, signal?: AbortSignal): Promise<void>;
  /** Reframe with a crop window that pans along a focal-point track. */
  reframeTracked(
    inputPath: string,
    outputPath: string,
    opts: TrackedReframeOptions,
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
  ): Promise<{ packets: number; nonMonotonic: number }> {
    const { stdout } = await this.exec(
      this.ffprobePath,
      buildVideoPacketDtsArgs({ inputPath }),
      signal,
    );
    let packets = 0;
    let nonMonotonic = 0;
    let prev = Number.NEGATIVE_INFINITY;
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (t === "") continue;
      packets++;
      // "N/A" appears when a packet carries no DTS at all — equally unseekable.
      const dts = Number(t);
      if (!Number.isFinite(dts) || dts <= prev) {
        nonMonotonic++;
        continue;
      }
      prev = dts;
    }
    return { packets, nonMonotonic };
  }

  async cut(inputPath: string, outputPath: string, opts: CutOptions, signal?: AbortSignal): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await this.exec(
      this.ffmpegPath,
      buildCutArgs({ inputPath, outputPath, startMs: opts.startMs, endMs: opts.endMs, crf: opts.crf }),
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
