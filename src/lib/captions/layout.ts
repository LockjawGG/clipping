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
  /** Retained for karaoke/highlight animation; timings are absolute. */
  words: Word[];
}

const SENTENCE_END = /[.!?]["')\]]?$/;
const CLAUSE_END = /[,;:—-]$/;

/** Greedy line packing that prefers clause boundaries over raw character fit. */
export function packLines(words: Word[], maxCharsPerLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word.text}` : word.text;

    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      // A clause boundary near the end of the line is a better break than
      // wherever the next word happens to overflow.
      if (CLAUSE_END.test(word.text) && current.length >= maxCharsPerLine * 0.6) {
        lines.push(current);
        current = "";
      }
      continue;
    }

    if (current) lines.push(current);
    current = word.text;
  }

  if (current) lines.push(current);

  // If clause-preference produced more lines than allowed, re-pack the overflow
  // purely on width so we never drop words.
  if (lines.length > maxLines) {
    return repackHard(lines.join(" ").split(/\s+/), maxCharsPerLine);
  }
  return lines;
}

function repackHard(tokens: string[], maxCharsPerLine: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = token;
    }
  }
  if (current) lines.push(current);
  return lines;
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
    return {
      startMs: group[0].startMs,
      endMs: group[group.length - 1].endMs,
      lines: packLines(text, config.maxCharsPerLine, config.maxLines),
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
