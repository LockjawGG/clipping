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
import type { AudioCensorMode, CensorWordOverrides } from "./overrides.ts";

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
  /** Transcript word ids never censored, whatever the term lists say. */
  exemptWordIds?: readonly string[];
  /** Transcript word ids always censored, whatever the term lists say. */
  censorWordIds?: readonly string[];
  /**
   * Whether censored words are bleeped in the audio. This is only the clip-wide
   * default — the two id lists below override it per occurrence.
   *
   * Undefined means true, so a caller that predates the audio split (and every
   * test that does not care) keeps the old behaviour of bleeping what it masks.
   */
  audioEnabled?: boolean;
  /** Censored words left audible: masked in the captions, not bleeped. */
  audioExemptWordIds?: readonly string[];
  /** Censored words bleeped even when `audioEnabled` is false. */
  audioForceWordIds?: readonly string[];
  /** Per-occurrence settings (how to bleep, how to mask), by word id. */
  wordOverrides?: CensorWordOverrides;
}

export interface CensorSpan {
  /** Transcript word id when known, so the UI can highlight the exact word. */
  wordId?: string;
  /** Index into the words array that was passed in. */
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  /** `custom` is a term the user added; `manual` is a single occurrence they
   *  ticked by hand. */
  tier: CensorTier | "custom" | "manual";
  /** This occurrence's own audio mode, when it overrides the clip's. */
  audioMode?: AudioCensorMode;
}

/**
 * Whether one word is censored, and on whose authority.
 *
 * Precedence runs most specific to least, so a decision the user made about
 * *this occurrence* is never overridden by a rule about the word in general:
 *
 *   1. this word id was ticked / unticked by hand
 *   2. this term is on the clip's allow / deny list   (automatic detection)
 *   3. the built-in lexicon                           (automatic detection)
 *
 * Levels 2 and 3 are what the clip's censoring toggle switches off; level 1 is
 * an explicit instruction and always applies.
 *
 * Returning the tier rather than a boolean is what lets the review panel say
 * which of those three decided it.
 */
/** The lexicon and term-list decision alone, for text with no word ids. */
function classifyBase(
  text: string,
  ctx: { lex: Map<string, CensorTier>; allow: Set<string>; deny: Set<string>; auto: boolean },
): CensorTier | "custom" | null {
  if (!ctx.auto) return null;
  const token = normalizeToken(text);
  if (!token) return null;
  const candidates = stems(token);
  if (candidates.some((c) => ctx.allow.has(c))) return null;
  for (const c of candidates) {
    if (ctx.deny.has(c)) return "custom";
    const hit = ctx.lex.get(c);
    if (hit) return hit;
  }
  return null;
}

function maskTier(
  word: CensorWord,
  index: number,
  ctx: {
    lex: Map<string, CensorTier>;
    allow: Set<string>;
    deny: Set<string>;
    exemptIds: Set<string>;
    censorIds: Set<string>;
    /** Whether automatic detection is switched on for this clip. */
    auto: boolean;
  },
): CensorTier | "custom" | "manual" | null {
  const id = word.id;
  if (id) {
    if (ctx.exemptIds.has(id)) return null;
    // A hand-picked occurrence is an explicit instruction, so it applies even
    // with automatic detection switched off. The toggle governs *finding*
    // words, not overriding ones the user pointed at.
    if (ctx.censorIds.has(id)) return "manual";
  }
  if (!ctx.auto) return null;

  const token = normalizeToken(word.text);
  if (!token) return null;

  const candidates = stems(token);
  // The allow-list wins over everything below it — it is how a user rescues a
  // false positive without editing the shared lexicon.
  if (candidates.some((c) => ctx.allow.has(c))) return null;
  for (const c of candidates) {
    if (ctx.deny.has(c)) return "custom";
    const hit = ctx.lex.get(c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Is this occurrence bleeped in the audio?
 *
 * The audio is a *parallel* decision, not a refinement of the mask. By default
 * it follows the mask — marking a word censors it everywhere, which is what
 * people expect — but either of its own overrides can break that in either
 * direction, so all four combinations are reachable:
 *
 *   masked + bleeped    the ordinary case
 *   masked, audible     "show s*** but let them hear it"
 *   bleeped, unmasked   silence a name or a detail the captions never showed
 *   neither             untouched
 *
 * That is why the force check comes before the mask lookup: an audio-forced
 * word is bleeped whether or not anything masks it.
 */
function audioTier(
  word: CensorWord,
  index: number,
  ctx: AudioCtx,
): CensorTier | "custom" | "manual" | null {
  const id = word.id;
  if (id) {
    if (ctx.audioForceIds.has(id)) return "manual";
    if (ctx.audioExemptIds.has(id)) return null;
  }
  if (!ctx.audio) return null;
  return maskTier(word, index, ctx);
}

type AudioCtx = ReturnType<typeof context>;

/** The sets the classifiers need, built once per call rather than per word. */
function context(config: CensorConfigInput) {
  return {
    lex: lexiconFor(config.sensitivity),
    allow: new Set((config.allowList ?? []).map(normalizeToken).filter(Boolean)),
    deny: new Set((config.denyList ?? []).map(normalizeToken).filter(Boolean)),
    exemptIds: new Set(config.exemptWordIds ?? []),
    censorIds: new Set(config.censorWordIds ?? []),
    auto: config.enabled,
    audio: config.audioEnabled ?? true,
    audioExemptIds: new Set(config.audioExemptWordIds ?? []),
    audioForceIds: new Set(config.audioForceWordIds ?? []),
    overrides: config.wordOverrides ?? {},
  };
}

/**
 * Is there anything for the censor pass to do?
 *
 * Not the same as `enabled`: a clip with automatic detection off but words
 * ticked by hand still has to run, or those marks would be silently dropped.
 */
export function censorHasWork(config: CensorConfigInput): boolean {
  return (
    config.enabled ||
    (config.censorWordIds?.length ?? 0) > 0 ||
    // An audio-only mark is work too, even though it masks nothing.
    (config.audioForceWordIds?.length ?? 0) > 0
  );
}

/**
 * Is there anything for the *audio* pass to do?
 *
 * With the clip-wide switch off there can still be individually forced words,
 * which is exactly the case a plain `audioEnabled` check would drop.
 */
export function censorHasAudioWork(config: CensorConfigInput): boolean {
  if (!censorHasWork(config)) return false;
  return (config.audioEnabled ?? true) || (config.audioForceWordIds?.length ?? 0) > 0;
}

export interface TextRun {
  text: string;
  censored: boolean;
}

/**
 * Split written text into runs of clean words and censored ones.
 *
 * For text that has no timings — narration scripts, and the transcript lines
 * they are read from. The per-occurrence id lists cannot apply here, since
 * these words are not transcript words, so only the lexicon and the clip's own
 * term lists decide.
 *
 * Runs rather than positions because the caller cannot seek inside speech it
 * has not synthesised yet: it has to build the line out of pieces, and a run is
 * the piece. Consecutive censored words stay together so "fucking hell" becomes
 * one bleep rather than two abutting ones.
 */
export function splitCensoredRuns(text: string, config: CensorConfigInput): TextRun[] {
  const ctx = context(config);
  const runs: TextRun[] = [];
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    // Whitespace joins whichever run it follows, so rebuilding the parts and
    // concatenating their audio does not lose the spacing.
    const isSpace = /^\s+$/.test(token);
    const censored = !isSpace && classifyBase(token, ctx) !== null;
    const last = runs[runs.length - 1];
    if (last && (last.censored === censored || (isSpace && runs.length > 0))) {
      last.text += token;
    } else {
      runs.push({ text: token, censored });
    }
  }
  return runs.filter((r) => r.text.trim().length > 0 || !r.censored);
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
  return collect(words, config, padMs, false);
}

/**
 * The subset of `detectSpans` that is actually bleeped.
 *
 * Filtering happens *before* merging, because merging two adjacent spans of
 * which only one is bleeped would silence a word the user chose to keep
 * audible — the filter has to decide membership, not trim the result.
 */
export function audioSpans(
  words: readonly CensorWord[],
  config: CensorConfigInput,
  padMs = 60,
): CensorSpan[] {
  return collect(words, config, padMs, true);
}

function collect(
  words: readonly CensorWord[],
  config: CensorConfigInput,
  padMs: number,
  audioOnly: boolean,
): CensorSpan[] {
  if (!censorHasWork(config)) return [];

  const ctx = context(config);
  const out: CensorSpan[] = [];
  words.forEach((w, index) => {
    const tier = audioOnly ? audioTier(w, index, ctx) : maskTier(w, index, ctx);
    if (!tier) return;

    const audioMode = w.id ? ctx.overrides[w.id]?.audioMode : undefined;
    out.push({
      ...(w.id ? { wordId: w.id } : {}),
      index,
      text: w.text,
      startMs: Math.max(0, w.startMs - padMs),
      endMs: Math.max(w.startMs + 1, w.endMs + padMs),
      tier,
      ...(audioMode ? { audioMode } : {}),
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
    // Two touching words with different audio modes stay separate: merging a
    // muted word into a beeped one would silently change how one of them
    // sounds.
    if (cur.startMs <= prev.endMs && cur.audioMode === prev.audioMode) {
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
  // Same classification as `detectSpans`, but without padding or merging so
  // indices stay exact — padding exists for audio, and merging would lose the
  // per-word identity this function is for.
  if (!censorHasWork(config)) return new Set();
  const ctx = context(config);
  const out = new Set<number>();
  words.forEach((w, index) => {
    if (maskTier(w, index, ctx)) out.add(index);
  });
  return out;
}

/** The same, for the words the audio will bleep. Not a subset of the above:
 *  the two axes are independent, so this can name a word that is never masked. */
export function bleepedIndices(
  words: readonly CensorWord[],
  config: CensorConfigInput,
): Set<number> {
  if (!censorHasAudioWork(config)) return new Set();
  const ctx = context(config);
  const out = new Set<number>();
  words.forEach((w, index) => {
    if (audioTier(w, index, ctx)) out.add(index);
  });
  return out;
}
