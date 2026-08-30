/**
 * Censor detection: transcript words + config -> spans to mask and bleep.
 *
 * Pure and deterministic. Nothing is persisted — a detection is a function of
 * the transcript and the config, so storing it would create a second source of
 * truth that goes stale the moment a transcript word is edited.
 *
 * Matching is whole-word against a stem list, never substring: "class" must not
 * trip on "ass" and "Scunthorpe" must not trip on anything. Words carry their
 * own punctuation from the transcriber, so the letter core is extracted first.
 */

import type { CensorSensitivity, CensorTier } from "./lexicon.ts";
import { lexiconFor } from "./lexicon.ts";

export interface CensorWord {
  id?: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface CensorConfigInput {
  enabled: boolean;
  sensitivity: CensorSensitivity;
  /** Terms never censored, even if the lexicon lists them. Beats `denyList`. */
  allowList?: readonly string[];
  /** Extra terms to censor. This is where anything beyond plain profanity
   *  belongs — authored by the user, reviewed before it is applied. */
  denyList?: readonly string[];
}

export interface CensorSpan {
  /** Transcript word id when known, so the UI can highlight the exact word. */
  wordId?: string;
  /** Index into the words array that was passed in. */
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  /** `custom` marks a hit from the user's own denyList. */
  tier: CensorTier | "custom";
}

/**
 * Inflections folded back to a stem before lookup, longest first so "ers"
 * beats "s". Kept small on purpose: aggressive stemming invents matches.
 */
const SUFFIXES = ["ingly", "ing", "ers", "er", "ed", "es", "s", "y"];

/** The letter core of a token: lowercase, punctuation and digits stripped. */
export function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^\p{L}]+/u, "")
    .replace(/[^\p{L}]+$/u, "")
    // Internal apostrophes are part of the word ("fuckin'"), other internal
    // punctuation is not.
    .replace(/[^\p{L}']/gu, "");
}

/**
 * Candidate stems for a token: itself, plus de-inflected forms.
 *
 * Runs in two stages because the dropped-g colloquialism has to be restored
 * *before* de-inflection can work: "fuckin" only reaches "fuck" by way of
 * "fucking", so stripping suffixes off the raw token alone would miss it.
 */
function stems(token: string): string[] {
  const bases = [token];
  const trimmed = token.replace(/'+$/, "");
  if (trimmed !== token) bases.push(trimmed);
  // "fuckin" -> "fucking", so the "ing" rule below can reach "fuck".
  if (trimmed.endsWith("in")) bases.push(`${trimmed}g`);

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };

  for (const base of bases) {
    add(base);
    for (const suffix of SUFFIXES) {
      if (base.length > suffix.length + 2 && base.endsWith(suffix)) {
        const cut = base.slice(0, -suffix.length);
        add(cut);
        // Doubled consonant before the suffix: "shitting" -> "shitt" -> "shit".
        if (/(.)\1$/.test(cut)) add(cut.slice(0, -1));
      }
    }
  }
  return out;
}

/**
 * Spans for every word that should be censored, in transcript order.
 *
 * `padMs` widens each span at both ends: a bleep cut exactly on the word
 * boundary clips the consonant and the profanity stays audible.
 */
export function detectSpans(
  words: readonly CensorWord[],
  config: CensorConfigInput,
  padMs = 60,
): CensorSpan[] {
  if (!config.enabled) return [];

  const lex = lexiconFor(config.sensitivity);
  const allow = new Set((config.allowList ?? []).map(normalizeToken).filter(Boolean));
  const deny = new Set((config.denyList ?? []).map(normalizeToken).filter(Boolean));

  const out: CensorSpan[] = [];
  words.forEach((w, index) => {
    const token = normalizeToken(w.text);
    if (!token) return;

    const candidates = stems(token);
    // The allow-list wins outright — it is how a user rescues a false positive.
    if (candidates.some((c) => allow.has(c))) return;

    let tier: CensorTier | "custom" | null = null;
    for (const c of candidates) {
      if (deny.has(c)) {
        tier = "custom";
        break;
      }
      const hit = lex.get(c);
      if (hit) {
        tier = hit;
        break;
      }
    }
    if (!tier) return;

    out.push({
      ...(w.id ? { wordId: w.id } : {}),
      index,
      text: w.text,
      startMs: Math.max(0, w.startMs - padMs),
      endMs: Math.max(w.startMs + 1, w.endMs + padMs),
      tier,
    });
  });

  return mergeOverlapping(out);
}

/**
 * Merge spans that touch, so consecutive profanity becomes one continuous
 * bleep instead of a stutter of separate tones.
 */
function mergeOverlapping(spans: CensorSpan[]): CensorSpan[] {
  if (spans.length <= 1) return spans;
  const out: CensorSpan[] = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const prev = out[out.length - 1];
    const cur = spans[i];
    if (cur.startMs <= prev.endMs) {
      // Keep both words' identity in the text so the review UI reads sensibly.
      out[out.length - 1] = {
        ...prev,
        text: `${prev.text} ${cur.text}`,
        endMs: Math.max(prev.endMs, cur.endMs),
      };
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** The set of word indices covered by the spans, for masking captions. */
export function censoredIndices(
  words: readonly CensorWord[],
  config: CensorConfigInput,
): Set<number> {
  // Re-run without padding and without merging so indices stay exact — the
  // padding exists for audio, and merging would lose per-word identity.
  if (!config.enabled) return new Set();
  const lex = lexiconFor(config.sensitivity);
  const allow = new Set((config.allowList ?? []).map(normalizeToken).filter(Boolean));
  const deny = new Set((config.denyList ?? []).map(normalizeToken).filter(Boolean));

  const out = new Set<number>();
  words.forEach((w, index) => {
    const token = normalizeToken(w.text);
    if (!token) return;
    const candidates = stems(token);
    if (candidates.some((c) => allow.has(c))) return;
    if (candidates.some((c) => deny.has(c) || lex.has(c))) out.add(index);
  });
  return out;
}
