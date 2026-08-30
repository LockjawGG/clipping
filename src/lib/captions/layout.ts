import type { Word } from "../providers/types.ts";

/**
 * Turns word-level timings into renderable cues.
 *
 * This is the piece most clipping tools get subtly wrong. The failure modes are
 * all invisible until you watch the export:
 *
 *  - Breaking purely on character count puts line breaks mid-clause, which reads
 *    badly even though every line is under the limit.
 *  - Letting a cue inherit a long pause makes captions hang on screen after the
 *    speaker stopped. We split on gaps instead.
 *  - Clamping a cue to a minimum duration without pushing the next cue's start
 *    creates overlapping cues, which ASS/libass renders as stacked text.
 *
 * Cues returned are guaranteed non-overlapping and in ascending time order.
 */

export interface CaptionConfig {
  maxCharsPerLine: number;
  maxLines: number;
  maxWordsPerCue: number;
  minCueMs: number;
  maxCueMs: number;
  /** A silence at least this long forces a cue break. */
  gapSplitMs: number;
  uppercase: boolean;
}

export const DEFAULT_CAPTION_CONFIG: CaptionConfig = {
  maxCharsPerLine: 38,
  maxLines: 2,
  maxWordsPerCue: 7,
  minCueMs: 800,
  maxCueMs: 5000,
  gapSplitMs: 700,
  uppercase: false,
};

export interface Cue {
  startMs: number;
  endMs: number;
  lines: string[];
  /** The same words split into the wrapped display lines (parallel to `lines`). */
  lineGroups: Word[][];
  /** Retained for karaoke/highlight animation; timings are absolute. */
  words: Word[];
}

const SENTENCE_END = /[.!?]["')\]]?$/;
const CLAUSE_END = /[,;:—-]$/;

/**
 * Greedy line packing that prefers clause boundaries over raw character fit.
 * Returns the words grouped per display line (word objects retained so per-word
 * styling can survive into the render).
 */
export function packLineGroups(
  words: Word[],
  maxCharsPerLine: number,
  maxLines: number,
): Word[][] {
  const lines: Word[][] = [];
  let current: Word[] = [];
  let len = 0;
  const flush = () => {
    if (current.length) lines.push(current);
    current = [];
    len = 0;
  };

  for (const word of words) {
    const candidate = (len ? len + 1 : 0) + word.text.length;
    if (candidate <= maxCharsPerLine) {
      current.push(word);
      len = candidate;
      if (CLAUSE_END.test(word.text) && len >= maxCharsPerLine * 0.6) flush();
      continue;
    }
    flush();
    current = [word];
    len = word.text.length;
  }
  flush();

  // Clause-preference produced more lines than allowed — re-pack purely on
  // width so we never drop words, keeping the word objects.
  if (lines.length > maxLines) {
    const flat = lines.flat();
    const hard: Word[][] = [];
    let cur: Word[] = [];
    let l = 0;
    for (const w of flat) {
      const c = (l ? l + 1 : 0) + w.text.length;
      if (c <= maxCharsPerLine) {
        cur.push(w);
        l = c;
      } else {
        if (cur.length) hard.push(cur);
        cur = [w];
        l = w.text.length;
      }
    }
    if (cur.length) hard.push(cur);
    return hard;
  }
  return lines;
}

/** String form of {@link packLineGroups}. */
export function packLines(words: Word[], maxCharsPerLine: number, maxLines: number): string[] {
  return packLineGroups(words, maxCharsPerLine, maxLines).map((g) =>
    g.map((w) => w.text).join(" "),
  );
}

/** Splits the word stream into groups that will each become one cue. */
function groupWords(words: Word[], config: CaptionConfig): Word[][] {
  const groups: Word[][] = [];
  let current: Word[] = [];

  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);

    const next = words[i + 1];
    if (!next) break;

    const charBudget = config.maxCharsPerLine * config.maxLines;
    const chars = current.reduce((n, w) => n + w.text.length + 1, 0) - 1;
    const duration = next.endMs - current[0].startMs;
    const gap = next.startMs - word.endMs;

    if (
      SENTENCE_END.test(word.text) ||
      gap >= config.gapSplitMs ||
      current.length >= config.maxWordsPerCue ||
      chars + next.text.length + 1 > charBudget ||
      duration > config.maxCueMs
    ) {
      flush();
    }
  }

  flush();
  return groups;
}

export function buildCues(words: Word[], config: CaptionConfig = DEFAULT_CAPTION_CONFIG): Cue[] {
  const usable = words.filter((w) => w.text.trim().length > 0 && w.endMs > w.startMs);
  if (usable.length === 0) return [];

  const cues: Cue[] = groupWords(usable, config).map((group) => {
    const text = config.uppercase
      ? group.map((w) => ({ ...w, text: w.text.toUpperCase() }))
      : group;
    const lineGroups = packLineGroups(text, config.maxCharsPerLine, config.maxLines);
    return {
      startMs: group[0].startMs,
      endMs: group[group.length - 1].endMs,
      lines: lineGroups.map((g) => g.map((w) => w.text).join(" ")),
      lineGroups,
      words: text,
    };
  });

  // Extend short cues, but never past the next cue's start. Trimming to the
  // neighbour rather than clamping is what keeps cues non-overlapping.
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    const ceiling = next ? next.startMs : Number.POSITIVE_INFINITY;

    if (cue.endMs - cue.startMs < config.minCueMs) {
      cue.endMs = Math.min(cue.startMs + config.minCueMs, ceiling);
    }
    if (cue.endMs - cue.startMs > config.maxCueMs) {
      cue.endMs = cue.startMs + config.maxCueMs;
    }
    if (next && cue.endMs > next.startMs) {
      cue.endMs = next.startMs;
    }
  }

  return cues.filter((c) => c.endMs > c.startMs);
}

function srtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/**
 * Shift absolute cue times onto the clip's own timeline.
 *
 * `toSrt` does this inline for the burned path. The Remotion composition needs
 * the same thing done to the objects themselves, because its clock starts at
 * the clip: fed absolute times, no cue is ever active and the render comes out
 * with no captions at all — silently, since nothing errors.
 *
 * Word timings shift too, as they drive the karaoke highlight, and they are
 * deliberately not clamped: a word that began before the clip should read as
 * already under way rather than restarting at zero.
 */
export function rebaseCues(cues: Cue[], offsetMs: number): Cue[] {
  if (!offsetMs) return cues;
  const shift = (w: Word): Word => ({
    ...w,
    startMs: w.startMs - offsetMs,
    endMs: w.endMs - offsetMs,
  });
  return cues.map((cue) => ({
    ...cue,
    startMs: Math.max(0, cue.startMs - offsetMs),
    endMs: Math.max(0, cue.endMs - offsetMs),
    words: cue.words.map(shift),
    lineGroups: cue.lineGroups.map((group) => group.map(shift)),
  }));
}

/** Cue times are absolute; `offsetMs` rebases them onto the clip's timeline. */
export function toSrt(cues: Cue[], offsetMs = 0): string {
  return cues
    .map((cue, i) => {
      const start = Math.max(0, cue.startMs - offsetMs);
      const end = Math.max(0, cue.endMs - offsetMs);
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${cue.lines.join("\n")}\n`;
    })
    .join("\n");
}

/** Per-word style attributes that libass can burn from an SRT tag. */
export interface SrtWordStyle {
  color?: string | null;
  bold?: boolean | null;
  italic?: boolean | null;
}

function styleWord(text: string, s: SrtWordStyle | undefined): string {
  if (!s || (!s.color && !s.bold && !s.italic)) return text;
  let out = text;
  if (s.italic) out = `<i>${out}</i>`;
  if (s.bold) out = `<b>${out}</b>`;
  if (s.color) out = `<font color="${s.color}">${out}</font>`;
  return out;
}

/**
 * Like {@link toSrt}, but wraps individual words in libass-supported SRT tags
 * (`<font color>`, `<b>`, `<i>`) from `styles`, keyed by word id. Words with no
 * override, and cues with no styled words, are emitted exactly as `toSrt` would.
 */
export function toStyledSrt(
  cues: Cue[],
  offsetMs: number,
  styles: Record<string, SrtWordStyle>,
): string {
  return cues
    .map((cue, i) => {
      const start = Math.max(0, cue.startMs - offsetMs);
      const end = Math.max(0, cue.endMs - offsetMs);
      const body = cue.lineGroups
        .map((line) =>
          line.map((w) => styleWord(w.text, w.id ? styles[w.id] : undefined)).join(" "),
        )
        .join("\n");
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${body}\n`;
    })
    .join("\n");
}

/**
 * WebVTT form of {@link toSrt}, for a browser `<track>` preview (no ffmpeg).
 * Same cue walk; VTT uses a `.` millisecond separator and a `WEBVTT` header,
 * and cue-index lines are optional so we drop them.
 */
export function toVtt(cues: Cue[], offsetMs = 0): string {
  const body = cues
    .map((cue) => {
      const start = Math.max(0, cue.startMs - offsetMs);
      const end = Math.max(0, cue.endMs - offsetMs);
      const time = `${srtTime(start).replace(",", ".")} --> ${srtTime(end).replace(",", ".")}`;
      return `${time}\n${cue.lines.join("\n")}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
