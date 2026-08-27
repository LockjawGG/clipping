import type { Segment, Word } from "../providers/types.ts";

/**
 * Shared post-processing for provider output.
 *
 * Every provider reports times in floating-point seconds. The rest of the app
 * runs on integer milliseconds (see the schema notes), so the first thing any
 * parser does is `secToMs`. These helpers also repair the small
 * inconsistencies real transcription output has: words a hair out of order, a
 * word whose end is before its start, a segment with no words.
 */

export function secToMs(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.round(seconds * 1000));
}

/** Clamp a word to sane, monotonic bounds. */
export function cleanWord(w: Word): Word {
  const startMs = Math.max(0, Math.round(w.startMs));
  const endMs = Math.max(startMs, Math.round(w.endMs));
  const word: Word = { text: w.text, startMs, endMs };
  if (typeof w.confidence === "number") word.confidence = clamp01(w.confidence);
  return word;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

const SENTENCE_END = /[.!?]["')\]]?$/;

export interface GroupOptions {
  /** A silence at least this long ends a segment. */
  gapMs?: number;
  /** Hard cap on how many words land in one segment. */
  maxWords?: number;
}

/**
 * Fallback segmentation for providers that only return a word stream. Splits on
 * sentence-final punctuation, on a silence longer than `gapMs`, or when a
 * segment would exceed `maxWords`.
 */
export function groupWordsIntoSegments(words: Word[], options: GroupOptions = {}): Segment[] {
  const gapMs = options.gapMs ?? 700;
  const maxWords = options.maxWords ?? 60;
  const segments: Segment[] = [];
  let current: Word[] = [];

  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      text: current.map((w) => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1").trim(),
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      words: current,
    });
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);
    const next = words[i + 1];
    const gap = next ? next.startMs - word.endMs : Infinity;
    if (SENTENCE_END.test(word.text.trim()) || gap >= gapMs || current.length >= maxWords) {
      flush();
    }
  }
  flush();
  return segments;
}

/** Assign a flat word stream to pre-existing segment time ranges. */
export function attachWordsToSegments(
  segments: Array<Omit<Segment, "words">>,
  words: Word[],
): Segment[] {
  return segments.map((seg, idx) => {
    const next = segments[idx + 1];
    const hi = next ? next.startMs : Infinity;
    const inRange = words.filter(
      (w) => w.startMs >= seg.startMs - 1 && w.startMs < Math.max(seg.endMs, hi),
    );
    return { ...seg, words: inRange };
  });
}

/** Mean of the per-segment or per-word confidences, if any are present. */
export function meanConfidence(values: Array<number | undefined>): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return undefined;
  return clamp01(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/** Normalise a BCP-47-ish or full-word language label to a short lowercase code. */
export function normalizeLanguage(label: string | undefined): string {
  if (!label) return "en";
  const map: Record<string, string> = {
    english: "en",
    spanish: "es",
    french: "fr",
    german: "de",
    portuguese: "pt",
    italian: "it",
    dutch: "nl",
    japanese: "ja",
    korean: "ko",
  };
  const lower = label.toLowerCase();
  return map[lower] ?? lower.split(/[-_]/)[0];
}
