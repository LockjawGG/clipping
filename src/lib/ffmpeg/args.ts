/**
 * ffmpeg argument construction.
 *
 * Rule: nothing here returns a shell string. Everything returns an argv array
 * for execFile/spawn with shell:false. There is no quoting layer to get wrong
 * because there is no shell.
 *
 * The one place user input reaches ffmpeg's own parser is the `subtitles=`
 * filter, which has its own escaping rules independent of the shell. That is
 * handled explicitly below.
 */

export type AspectRatio = "9:16" | "1:1" | "16:9" | "4:5";

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/**
 * Paths handed to ffmpeg are always server-generated (storage keys, temp dirs),
 * never client filenames. This asserts that invariant rather than trying to
 * sanitise a hostile path into a safe one.
 */
const POSIX_ABSOLUTE = /^\//;
// `C:\`, `C:/`, or a UNC `\\host\share`.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

export function assertSafePath(path: string): void {
  if (path.length === 0) throw new Error("empty path");
  if (path.includes("\0")) throw new Error("path contains a null byte");
  if (!POSIX_ABSOLUTE.test(path) && !WINDOWS_ABSOLUTE.test(path)) {
    throw new Error(`path must be absolute: ${path}`);
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(path)) {
    throw new Error(`path contains a traversal segment: ${path}`);
  }
  // A leading dash on any segment would be parsed as an option, not a filename.
  if (/(^|[\\/])-/.test(path)) throw new Error(`path segment starts with a dash: ${path}`);
}

/**
 * Escapes a path for use inside ffmpeg's filtergraph.
 *
 * The filtergraph parser strips one level of backslashes, then the filter's own
 * option parser strips another. Colons separate options and commas separate
 * filters, so both need escaping. On the common path the temp filename is
 * already alphanumeric; this exists so an unusual mount point can't break the
 * graph.
 */
export function escapeFilterPath(path: string): string {
  return path
    .replace(/\\/g, "\\\\\\\\")
    .replace(/:/g, "\\\\:")
    .replace(/'/g, "\\\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/** Style for the burned-in (static) caption path — mapped to libass force_style. */
export interface CaptionBurnStyle {
  fontName: string;
  fontSizePx: number;
  /** >= 700 renders bold. */
  fontWeight: number;
  textColor: string;
  outlineColor: string;
  outlineWidthPx: number;
  /** `#rrggbb` for an opaque caption box, or null for outline-only. */
  backgroundColor: string | null;
  alignment: "left" | "center" | "right";
  /** 0 = top of frame, 1 = bottom. */
  positionY: number;
}

/** `#RRGGBB` → SSA `&H00BBGGRR` (alpha 00 = fully opaque). */
function hexToAss(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const rgb = m ? m[1] : "FFFFFF";
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

const ASS_ALIGNMENT: Record<CaptionBurnStyle["alignment"], number> = {
  left: 1,
  center: 2,
  right: 3,
};

/**
 * libass renders an SRT in its default script space (PlayResY = 288) and scales
 * that up to the frame, so `force_style` sizes/margins are expressed there, not
 * in output pixels. We convert the caller's pixel-space values with this factor.
 */
const PLAY_RES_Y = 288;

/** Build a libass `force_style=` value from a pixel-space caption style. */
export function buildForceStyle(
  style: CaptionBurnStyle,
  dims: { width: number; height: number },
): string {
  const k = PLAY_RES_Y / dims.height;
  // Bottom-anchored: distance of the text from the bottom edge.
  const marginV = Math.max(
    4,
    Math.min(PLAY_RES_Y - 4, Math.round((1 - style.positionY) * PLAY_RES_Y)),
  );
  const parts: Array<[string, string | number]> = [
    ["FontName", style.fontName],
    ["FontSize", Math.max(6, Math.round(style.fontSizePx * k))],
    ["PrimaryColour", hexToAss(style.textColor)],
    ["OutlineColour", hexToAss(style.outlineColor)],
    ["Bold", style.fontWeight >= 700 ? -1 : 0],
    ["Outline", Math.max(0, Math.round(style.outlineWidthPx * k))],
    ["Shadow", 0],
    ["Alignment", ASS_ALIGNMENT[style.alignment]],
    ["MarginV", marginV],
    ["MarginL", Math.round(48 * k)],
    ["MarginR", Math.round(48 * k)],
  ];
  if (style.backgroundColor) {
    // BorderStyle 3 draws an opaque box behind the text.
    parts.push(["BorderStyle", 3], ["BackColour", hexToAss(style.backgroundColor)]);
  } else {
    parts.push(["BorderStyle", 1]);
  }
  return parts.map(([key, v]) => `${key}=${v}`).join(",");
}

function msToTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`invalid timestamp: ${ms}`);
  const totalSeconds = ms / 1000;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

export interface ProbeArgs {
  inputPath: string;
}

export function buildProbeArgs({ inputPath }: ProbeArgs): string[] {
  assertSafePath(inputPath);
  return [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ];
}

export interface ExtractAudioArgs {
  inputPath: string;
  outputPath: string;
}

/** 16kHz mono PCM: what Whisper resamples to anyway, so we skip a conversion. */
export function buildExtractAudioArgs({ inputPath, outputPath }: ExtractAudioArgs): string[] {
  assertSafePath(inputPath);
  assertSafePath(outputPath);
  return [
    "-y",
    "-i", inputPath,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    outputPath,
  ];
}

export interface TranscodeAvArgs {
  inputPath: string;
  outputPath: string;
  /** Output frame rate. Screen capture is variable-rate; CFR makes it seekable. */
  fps?: number;
  crf?: number;
}

/**
 * Rebuild a recording as H.264/AAC at a constant frame rate.
 *
 * Used only when a stream copy of the reassembled fragments comes out with
 * non-monotonic timestamps, which a browser cannot seek through. Re-encoding
 * regenerates the timeline from frame order.
 *
 * x264 rather than libvpx: measured ~11x realtime against ~2.8x for VP8 on the
 * same 1080p content, and the rest of the pipeline already speaks MP4.
 */
export function buildTranscodeAvArgs({
  inputPath,
  outputPath,
  fps = 30,
  crf = 23,
}: TranscodeAvArgs): string[] {
  assertSafePath(inputPath);
  assertSafePath(outputPath);
  return [
    "-y",
    "-fflags",
    "+genpts+igndts",
    "-i",
    inputPath,
    // Re-stamp every frame from its ordinal rather than trusting input
    // timestamps. A byte-joined recording can carry timestamps that reset or
    // repeat mid-file; -fps_mode alone stops at the first apparent EOS and
    // truncates, whereas these filters read the whole stream through.
    "-vf",
    "setpts=N/FRAME_RATE/TB",
    "-af",
    "asetpts=N/SR/TB",
    "-r",
    String(fps),
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

export interface PacketDtsArgs {
  inputPath: string;
}

/**
 * ffprobe argv listing every video packet's decode timestamp, one per line.
 * Reading packets never decodes, so this scans an 8h recording in under a
 * minute — cheap enough to check a stream copy before trusting it.
 */
export function buildVideoPacketDtsArgs({ inputPath }: PacketDtsArgs): string[] {
  assertSafePath(inputPath);
  return [
    "-v",
    "error",
    "-select_streams",
    "v",
    "-show_entries",
    "packet=dts_time",
    "-of",
    "csv=p=0",
    inputPath,
  ];
}

export interface RemuxArgs {
  inputPath: string;
  outputPath: string;
}

/**
 * Rewrite a container without touching the streams — used to turn a raw
 * concatenation of MediaRecorder timeslice fragments into a clean, seekable
 * file (regenerated timestamps + a Cues index).
 */
export function buildRemuxArgs({ inputPath, outputPath }: RemuxArgs): string[] {
  assertSafePath(inputPath);
  assertSafePath(outputPath);
  return ["-y", "-fflags", "+genpts", "-i", inputPath, "-c", "copy", outputPath];
}

export interface CutArgs {
  inputPath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  crf?: number;
}

/**
 * Note the argument order: `-ss` before `-i` seeks fast, but combined with
 * re-encoding it stays frame-accurate because ffmpeg decodes from the preceding
 * keyframe and discards. Stream copy is deliberately not offered here — it
 * snaps the in-point to the nearest keyframe and silently shifts the cut.
 */
export function buildCutArgs({ inputPath, outputPath, startMs, endMs, crf = 18 }: CutArgs): string[] {
  assertSafePath(inputPath);
  assertSafePath(outputPath);
  if (endMs <= startMs) throw new Error(`end (${endMs}) must be after start (${startMs})`);
  if (!Number.isInteger(crf) || crf < 0 || crf > 51) throw new Error(`invalid crf: ${crf}`);

  return [
    "-y",
    "-ss", msToTimestamp(startMs),
    "-to", msToTimestamp(endMs),
    "-i", inputPath,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ];
}

export interface ReframeArgs {
  inputPath: string;
  outputPath: string;
  aspect: AspectRatio;
  /** Normalised 0..1 crop centre. Defaults to frame centre. */
  focalX?: number;
  focalY?: number;
  subtitlePath?: string;
  /** Applied to `subtitlePath` as libass `force_style`. */
  subtitleStyle?: CaptionBurnStyle;
  blurredBackground?: boolean;
}

/** The `subtitles=` filter entry, styled when a `CaptionBurnStyle` is given. */
function subtitlesFilter(
  subtitlePath: string,
  dims: { width: number; height: number },
  style?: CaptionBurnStyle,
): string {
  assertSafePath(subtitlePath);
  let f = `subtitles=${escapeFilterPath(subtitlePath)}`;
  if (style) {
    // The commas inside force_style would otherwise be read as filtergraph
    // separators (the surrounding quotes are not enough inside -filter_complex).
    const forced = buildForceStyle(style, dims).replace(/,/g, "\\,");
    f += `:force_style='${forced}'`;
  }
  return f;
}

/**
 * Reframes, then burns subtitles.
 *
 * Order matters and is a real bug source: burning captions before padding means
 * MarginV is measured against the pre-pad height, which drops the text into the
 * letterbox bar. Subtitles go last, against the final canvas.
 */
export function buildReframeArgs({
  inputPath,
  outputPath,
  aspect,
  focalX = 0.5,
  focalY = 0.5,
  subtitlePath,
  subtitleStyle,
  blurredBackground = false,
}: ReframeArgs): string[] {
  assertSafePath(inputPath);
  assertSafePath(outputPath);
  if (focalX < 0 || focalX > 1 || focalY < 0 || focalY > 1) {
    throw new Error(`focal point out of range: ${focalX}, ${focalY}`);
  }

  const { width, height } = ASPECT_DIMENSIONS[aspect];
  if (!width) throw new Error(`unknown aspect ratio: ${aspect}`);

  const filters: string[] = [];

  if (blurredBackground) {
    // Cover-scale a blurred copy behind a contain-scaled foreground.
    filters.push(
      `split[bg][fg]`,
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=20[bgb]`,
      `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgs]`,
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2`,
    );
  } else {
    // Cover-scale then crop around the focal point, clamped to stay in frame.
    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}:'min(max(0\\,iw*${focalX}-${width}/2)\\,iw-${width})':'min(max(0\\,ih*${focalY}-${height}/2)\\,ih-${height})'`,
    );
  }

  filters.push("setsar=1");

  if (subtitlePath) {
    filters.push(subtitlesFilter(subtitlePath, { width, height }, subtitleStyle));
  }

  return [
    "-y",
    "-i", inputPath,
    "-filter_complex", filters.join(","),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ];
}

export interface TrackedReframeArgs {
  inputPath: string;
  outputPath: string;
  aspect: AspectRatio;
  /** Focal-point keyframes (already smoothed/resampled). Needs at least 2. */
  cropX: string;
  cropY: string;
  subtitlePath?: string;
  /** Applied to `subtitlePath` as libass `force_style`. */
  subtitleStyle?: CaptionBurnStyle;
}

/**
 * Like `buildReframeArgs`, but the crop x/y are time-varying expressions
 * (see `focalTrackToCropExpr`) so the crop window pans to follow the subject.
 * The static builder stays untouched; callers pick this one only when they
 * have a track.
 */
export function buildTrackedReframeArgs({
  inputPath,
  outputPath,
  aspect,
  cropX,
  cropY,
  subtitlePath,
  subtitleStyle,
}: TrackedReframeArgs): string[] {
  assertSafePath(inputPath);
  assertSafePath(outputPath);

  const { width, height } = ASPECT_DIMENSIONS[aspect];
  if (!width) throw new Error(`unknown aspect ratio: ${aspect}`);
  if (!cropX || !cropY) throw new Error("cropX and cropY expressions are required");

  // Commas inside the expression would split the filtergraph; escape them.
  const x = cropX.replace(/,/g, "\\,");
  const y = cropY.replace(/,/g, "\\,");

  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}:'${x}':'${y}'`,
    "setsar=1",
  ];
  if (subtitlePath) {
    filters.push(subtitlesFilter(subtitlePath, { width, height }, subtitleStyle));
  }

  return [
    "-y",
    "-i", inputPath,
    "-filter_complex", filters.join(","),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ];
}

export interface ZoomReframeArgs {
  inputPath: string;
  outputPath: string;
  aspect: AspectRatio;
  /** `zoompan` expressions from `focusToZoompanExpr`. */
  zoomZ: string;
  zoomX: string;
  zoomY: string;
  /** Output frame rate; the expressions read `on/fps` to get elapsed time. */
  fps: number;
  subtitlePath?: string;
  subtitleStyle?: CaptionBurnStyle;
}

/**
 * A reframe whose capture window also zooms.
 *
 * `crop` cannot do this — a video stream's frame size is constant and `crop`'s
 * w/h are evaluated once at configuration time — so a zooming window goes
 * through `zoompan`, which crops a shrinking region and scales it back to a
 * fixed output size. Pure panning stays on `buildTrackedReframeArgs`, which is
 * cheaper and already proven.
 */
export function buildZoomReframeArgs({
  inputPath,
  outputPath,
  aspect,
  zoomZ,
  zoomX,
  zoomY,
  fps,
  subtitlePath,
  subtitleStyle,
}: ZoomReframeArgs): string[] {
  assertSafePath(inputPath);
  assertSafePath(outputPath);

  const { width, height } = ASPECT_DIMENSIONS[aspect];
  if (!width) throw new Error(`unknown aspect ratio: ${aspect}`);
  if (!zoomZ || !zoomX || !zoomY) throw new Error("zoom z/x/y expressions are required");
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`bad fps: ${fps}`);

  const esc = (e: string) => e.replace(/,/g, "\\,");
  const rate = Math.round(fps);

  const filters = [
    // Cover the target box first, so the window's normalised coordinates mean
    // the same thing here as they do on the crop path.
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    // d=1 keeps it to one output frame per input frame; the default holds each
    // input frame for 90 frames and the clip would run long.
    `zoompan=z='${esc(zoomZ)}':x='${esc(zoomX)}':y='${esc(zoomY)}':d=1:s=${width}x${height}:fps=${rate}`,
    "setsar=1",
  ];
  if (subtitlePath) {
    filters.push(subtitlesFilter(subtitlePath, { width, height }, subtitleStyle));
  }

  return [
    "-y",
    "-i", inputPath,
    "-filter_complex", filters.join(","),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ];
}

export interface OverlayCompositeItem {
  /** Absolute local path to the image/GIF. */
  path: string;
  /** Normalised 0..1 centre of the overlay within the frame. */
  x: number;
  y: number;
  /** Width as a fraction of the frame width (before the 30% baseline). 1 ≈ 30%. */
  scale: number;
  /** 0..1. */
  opacity: number;
  /** Clip-relative seconds; null = that edge of the clip. */
  startSec: number | null;
  endSec: number | null;
  /** Loop the source (animated GIFs). */
  loop?: boolean;
}

export interface OverlayCompositeArgs {
  inputPath: string;
  outputPath: string;
  frameWidth: number;
  items: OverlayCompositeItem[];
}

/** A number that is safe to drop straight into a filtergraph (finite, bounded). */
function fgNum(n: number, lo: number, hi: number): string {
  if (!Number.isFinite(n)) throw new Error(`non-finite filter value: ${n}`);
  return String(Math.min(hi, Math.max(lo, n)));
}

/**
 * Composite one or more still images / GIFs onto a video, each within its own
 * time window. Position is normalised so the same overlay lands sensibly on any
 * aspect ratio. Audio is passed through untouched.
 */
export function buildOverlayCompositeArgs({
  inputPath,
  outputPath,
  frameWidth,
  items,
}: OverlayCompositeArgs): string[] {
  assertSafePath(inputPath);
  assertSafePath(outputPath);
  if (items.length === 0) throw new Error("no overlay items");
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) {
    throw new Error(`bad frameWidth: ${frameWidth}`);
  }

  const inputs: string[] = ["-y", "-i", inputPath];
  const chains: string[] = [];
  let prev = "0:v";

  items.forEach((it, i) => {
    assertSafePath(it.path);
    if (it.loop) inputs.push("-ignore_loop", "0");
    inputs.push("-i", it.path);

    const idx = i + 1;
    const w = Math.max(8, Math.round(frameWidth * 0.3 * Math.min(4, Math.max(0.02, it.scale))));
    const aa = fgNum(it.opacity, 0, 1);
    chains.push(
      `[${idx}:v]scale=${w}:-1,format=rgba,colorchannelmixer=aa=${aa}[ov${i}]`,
    );

    const x = `(W-w)*${fgNum(it.x, 0, 1)}`;
    const y = `(H-h)*${fgNum(it.y, 0, 1)}`;
    let enable = "";
    if (it.startSec !== null || it.endSec !== null) {
      const s = fgNum(it.startSec ?? 0, 0, 1e6);
      const e = it.endSec !== null ? fgNum(it.endSec, 0, 1e6) : null;
      enable = e !== null ? `:enable='between(t,${s},${e})'` : `:enable='gte(t,${s})'`;
    }
    const out = i === items.length - 1 ? "vout" : `b${i}`;
    chains.push(
      `[${prev}][ov${i}]overlay=x='${x}':y='${y}':eof_action=pass${enable}[${out}]`,
    );
    prev = out;
  });

  return [
    ...inputs,
    "-filter_complex", chains.join(";"),
    "-map", "[vout]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ];
}

export interface ThumbnailArgs {
  inputPath: string;
  outputPath: string;
  atMs: number;
  width?: number;
}

export function buildThumbnailArgs({ inputPath, outputPath, atMs, width = 640 }: ThumbnailArgs): string[] {
  assertSafePath(inputPath);
  assertSafePath(outputPath);
  return [
    "-y",
    "-ss", msToTimestamp(atMs),
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    outputPath,
  ];
}
