/**
 * Feature extraction: one finished edit reduced to numbers.
 *
 * This is the unit of learning. It runs once, when the user approves a project
 * for training, and the result is stored — so rebuilding a profile later never
 * touches the original media, and a profile rebuild is an aggregate over a few
 * hundred small vectors rather than a re-analysis.
 *
 * Pure and dependency-free: everything it needs is already persisted on the
 * clip, its caption config and its overlays.
 */

export type ContentType =
  | "PODCAST"
  | "INTERVIEW"
  | "GAMING"
  | "COMMENTARY"
  | "EDUCATIONAL"
  | "NEWS"
  | "VLOG"
  | "SHORT"
  | "LONGFORM"
  | "UNKNOWN";

export const CONTENT_TYPES: ContentType[] = [
  "PODCAST",
  "INTERVIEW",
  "GAMING",
  "COMMENTARY",
  "EDUCATIONAL",
  "NEWS",
  "VLOG",
  "SHORT",
  "LONGFORM",
  "UNKNOWN",
];

/** The state of one finished clip, as the extractor reads it. */
export interface ClipSnapshot {
  startMs: number;
  endMs: number;
  aspectRatio: string;
  /** Words the user struck out — evidence of how aggressively they trim. */
  removedWordCount?: number;
  /** Whether an authored capture window was used, and how far it zoomed. */
  focusKeyframeCount?: number;
  maxFocusScale?: number;
  captions: {
    enabled: boolean;
    templateId?: string | null;
    animation?: string | null;
    fontFamily?: string | null;
    fontSizePx?: number | null;
    positionY?: number | null;
    highlightUsed?: boolean;
  } | null;
  overlays: Array<{
    kind: string;
    role?: string | null;
    /** Parsed `ElementAnimSpec` ids, when the layer carries motion. */
    intro?: string | null;
    loop?: string | null;
    outro?: string | null;
  }>;
  censorEnabled?: boolean;
}

/** The extracted vector. Small on purpose — it is stored per example. */
export interface StyleFeatures {
  version: 1;
  pacing: {
    durationMs: number;
    removedWordCount: number;
    trimmed: boolean;
  };
  captions: {
    used: boolean;
    templateId: string | null;
    animation: string | null;
    fontFamily: string | null;
    fontSizePx: number | null;
    positionY: number | null;
    highlight: boolean;
  };
  motion: {
    /** Counts by preset id, so the aggregate can rank them. */
    intro: Record<string, number>;
    loop: Record<string, number>;
    outro: Record<string, number>;
    overlayCount: number;
    textLayerCount: number;
  };
  framing: {
    aspectRatio: string;
    /** Whether the user placed a capture window at all. */
    captureWindow: boolean;
    maxZoom: number;
  };
  polish: {
    censored: boolean;
  };
}

function bump(into: Record<string, number>, key: string | null | undefined): void {
  if (!key || key === "none") return;
  into[key] = (into[key] ?? 0) + 1;
}

/** Reduce one finished clip to its feature vector. */
export function extractFeatures(clip: ClipSnapshot): StyleFeatures {
  const intro: Record<string, number> = {};
  const loop: Record<string, number> = {};
  const outro: Record<string, number> = {};
  let textLayerCount = 0;

  for (const o of clip.overlays) {
    if (o.kind === "TEXT") textLayerCount++;
    bump(intro, o.intro);
    bump(loop, o.loop);
    bump(outro, o.outro);
  }

  const c = clip.captions;
  const removedWordCount = clip.removedWordCount ?? 0;

  return {
    version: 1,
    pacing: {
      durationMs: Math.max(0, clip.endMs - clip.startMs),
      removedWordCount,
      trimmed: removedWordCount > 0,
    },
    captions: {
      used: !!c?.enabled,
      templateId: c?.templateId ?? null,
      animation: c?.animation ?? null,
      fontFamily: c?.fontFamily ?? null,
      fontSizePx: c?.fontSizePx ?? null,
      positionY: c?.positionY ?? null,
      highlight: !!c?.highlightUsed,
    },
    motion: {
      intro,
      loop,
      outro,
      overlayCount: clip.overlays.length,
      textLayerCount,
    },
    framing: {
      aspectRatio: clip.aspectRatio,
      captureWindow: (clip.focusKeyframeCount ?? 0) > 0,
      maxZoom: clip.maxFocusScale ?? 1,
    },
    polish: {
      censored: !!clip.censorEnabled,
    },
  };
}

/** Parse a stored vector. A malformed or future-version blob yields null. */
export function parseFeatures(json: unknown): StyleFeatures | null {
  const p = typeof json === "string" ? safeJson(json) : json;
  if (!p || typeof p !== "object") return null;
  const f = p as Partial<StyleFeatures>;
  if (f.version !== 1 || !f.pacing || !f.captions || !f.motion || !f.framing) return null;
  return f as StyleFeatures;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * A cheap content-type guess from what is known at ingest.
 *
 * Deliberately conservative: it returns UNKNOWN unless the signal is fairly
 * clear, because a wrong guess files the example under the wrong profile and
 * quietly poisons it. The user can always set it explicitly, and that override
 * is the authority.
 */
export function guessContentType(input: {
  durationMs: number | null;
  /** Distinct diarised speakers, when the transcriber provided them. */
  speakerCount?: number;
  /** Words per minute across the transcript. */
  wordsPerMinute?: number;
}): ContentType {
  const { durationMs, speakerCount, wordsPerMinute } = input;
  if (!durationMs || durationMs <= 0) return "UNKNOWN";
  const minutes = durationMs / 60_000;

  // Anything under a minute is a short by shape, whatever it contains.
  if (minutes <= 1) return "SHORT";

  if (speakerCount !== undefined) {
    // Two people for a long stretch is the podcast/interview shape. Telling
    // those two apart needs more than turn-taking, so this does not try.
    if (speakerCount >= 2 && minutes >= 15) return "PODCAST";
    if (speakerCount >= 2 && minutes >= 5) return "INTERVIEW";
    // A single speaker talking fast for a long time is commentary; slower and
    // more measured reads as educational. This is a weak signal on purpose.
    if (speakerCount === 1 && minutes >= 5 && wordsPerMinute !== undefined) {
      if (wordsPerMinute >= 170) return "COMMENTARY";
      if (wordsPerMinute <= 130) return "EDUCATIONAL";
    }
  }

  if (minutes >= 20) return "LONGFORM";
  return "UNKNOWN";
}
