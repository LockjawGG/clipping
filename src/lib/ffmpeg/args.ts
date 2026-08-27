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
export function assertSafePath(path: string): void {
  if (path.length === 0) throw new Error("empty path");
  if (path.includes("\0")) throw new Error("path contains a null byte");
  if (!path.startsWith("/")) throw new Error(`path must be absolute: ${path}`);
  if (path.includes("..")) throw new Error(`path contains a traversal segment: ${path}`);
  // A leading dash would be parsed as an option, not a filename.
  if (/(^|\/)-/.test(path)) throw new Error(`path segment starts with a dash: ${path}`);
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
  blurredBackground?: boolean;
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
    assertSafePath(subtitlePath);
    filters.push(`subtitles=${escapeFilterPath(subtitlePath)}`);
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
    assertSafePath(subtitlePath);
    filters.push(`subtitles=${escapeFilterPath(subtitlePath)}`);
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
