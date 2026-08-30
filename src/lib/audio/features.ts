/**
 * Audio features: the signal side of highlight detection.
 *
 * Deliberately signal processing, not a model. Loudness, spectral flatness and
 * silence come out of one ffmpeg pass over the 16 kHz mono WAV that
 * `EXTRACT_AUDIO` already wrote — no second decode, no download, no inference,
 * and the result is deterministic enough to unit-test the way the ffmpeg arg
 * builders are.
 *
 * The load-bearing insight is that speech is harmonic and laughter, applause
 * and crowd noise are broadband. Spectral flatness separates them cleanly:
 * measured against a pure tone it reads 0.003, against white noise 0.835.
 */

/** Momentary loudness reported for digital silence; clamped to a sane floor. */
export const LUFS_FLOOR = -70;

export interface SilenceSpan {
  startMs: number;
  endMs: number;
}

export interface AudioFeatures {
  version: 1;
  /** Window size in ms; `loudness[i]` covers `[i*stepMs, (i+1)*stepMs)`. */
  stepMs: number;
  /** Momentary loudness in LUFS per window, floored at `LUFS_FLOOR`. */
  loudness: number[];
  /** Spectral flatness 0..1 per window. High = broadband, low = harmonic. */
  flatness: number[];
  silences: SilenceSpan[];
  durationMs: number;
}

const FRAME_RE = /^frame:\d+\s+pts:\S+\s+pts_time:([\d.]+)/;

/**
 * Parse ffmpeg's `ametadata=mode=print` dump.
 *
 * The format is a `frame:` header followed by `key=value` lines, so this is a
 * single forward scan with no lookahead. Unknown keys are ignored rather than
 * rejected — the filters emit a dozen statistics and we consume three.
 */
export function parseAudioFeatures(text: string, stepMs = 250): AudioFeatures {
  const loudness: number[] = [];
  const flatness: number[] = [];
  const silences: SilenceSpan[] = [];

  let curLoud: number | null = null;
  let curFlat: number | null = null;
  let haveFrame = false;
  let lastTimeSec = 0;
  let openSilence: number | null = null;

  const flush = () => {
    if (!haveFrame) return;
    loudness.push(curLoud === null ? LUFS_FLOOR : Math.max(LUFS_FLOOR, curLoud));
    flatness.push(curFlat === null ? 0 : Math.min(1, Math.max(0, curFlat)));
    curLoud = null;
    curFlat = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const frame = FRAME_RE.exec(line);
    if (frame) {
      flush();
      haveFrame = true;
      lastTimeSec = Number(frame[1]) || 0;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = Number(line.slice(eq + 1));
    if (!Number.isFinite(value)) continue;

    if (key === "lavfi.r128.M") curLoud = value;
    else if (key.startsWith("lavfi.aspectralstats.") && key.endsWith(".flatness")) {
      // Mono in practice; if a file ever arrives stereo, the first channel wins.
      if (curFlat === null) curFlat = value;
    } else if (key === "lavfi.silence_start") {
      openSilence = Math.max(0, Math.round(value * 1000));
    } else if (key === "lavfi.silence_end") {
      const end = Math.max(0, Math.round(value * 1000));
      // A silence_end without a start means the gap opened before analysis
      // began, which is still a real gap from zero.
      silences.push({ startMs: openSilence ?? 0, endMs: end });
      openSilence = null;
    }
  }
  flush();

  const durationMs = Math.max(
    Math.round(lastTimeSec * 1000) + stepMs,
    loudness.length * stepMs,
  );
  // A gap still open at EOF runs to the end of the audio.
  if (openSilence !== null && durationMs > openSilence) {
    silences.push({ startMs: openSilence, endMs: durationMs });
  }

  return { version: 1, stepMs, loudness, flatness, silences, durationMs };
}

/** Round-trip through storage. A malformed blob yields null, never a throw. */
export function parseStoredFeatures(json: string | null | undefined): AudioFeatures | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    if (
      p &&
      typeof p === "object" &&
      p.version === 1 &&
      Array.isArray(p.loudness) &&
      Array.isArray(p.flatness) &&
      typeof p.stepMs === "number"
    ) {
      return {
        version: 1,
        stepMs: p.stepMs,
        loudness: p.loudness as number[],
        flatness: p.flatness as number[],
        silences: Array.isArray(p.silences) ? (p.silences as SilenceSpan[]) : [],
        durationMs: typeof p.durationMs === "number" ? p.durationMs : 0,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Serialise for storage. Values are rounded hard — a 30-minute clip is ~7200
 * windows, and full float precision would triple the row for noise well below
 * what any threshold cares about.
 */
export function serializeFeatures(f: AudioFeatures): string {
  return JSON.stringify({
    version: 1,
    stepMs: f.stepMs,
    loudness: f.loudness.map((n) => Math.round(n * 10) / 10),
    flatness: f.flatness.map((n) => Math.round(n * 1000) / 1000),
    silences: f.silences,
    durationMs: f.durationMs,
  });
}
