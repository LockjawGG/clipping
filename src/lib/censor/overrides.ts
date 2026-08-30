/**
 * Per-occurrence censor *settings*, keyed by transcript word id.
 *
 * The exempt/force id lists answer "is this word censored at all"; this answers
 * "and how". They are kept apart because they behave differently: membership of
 * a list is a boolean the UI can toggle, while these are values that fall back
 * to the clip's own setting when absent.
 *
 * `undefined` on a field therefore means "follow the clip", not "off" — which
 * is why nothing here is given a default. Writing the clip's current value into
 * every word would freeze it, so changing the clip setting later would stop
 * reaching the words that never actually diverged.
 */

import type { CaptionCensorMode } from "./mask.ts";

export type AudioCensorMode = "MUTE" | "BEEP" | "TONE";

export interface CensorWordOverride {
  /** How this word is silenced. Absent = the clip's audio mode. */
  audioMode?: AudioCensorMode;
  /** How this word is written on screen. Absent = the clip's caption mode. */
  captionMode?: CaptionCensorMode;
  /** Replacement text for a CUSTOM caption mode on this word alone. */
  replacement?: string | null;
}

export type CensorWordOverrides = Record<string, CensorWordOverride>;

const AUDIO_MODES: readonly AudioCensorMode[] = ["MUTE", "BEEP", "TONE"];
const CAPTION_MODES: readonly CaptionCensorMode[] = ["FULL", "PARTIAL", "FIRST", "CUSTOM"];

/**
 * Read the stored JSON, discarding anything that is not a value we recognise.
 *
 * Lenient on purpose: this column is written by the editor and read by the
 * renderer, and a single unknown key must not fail a render. An override that
 * cannot be understood is simply absent, which falls back to the clip setting.
 */
export function parseWordOverrides(json: string | null | undefined): CensorWordOverrides {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: CensorWordOverrides = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const entry: CensorWordOverride = {};
    if (AUDIO_MODES.includes(v.audioMode as AudioCensorMode)) {
      entry.audioMode = v.audioMode as AudioCensorMode;
    }
    if (CAPTION_MODES.includes(v.captionMode as CaptionCensorMode)) {
      entry.captionMode = v.captionMode as CaptionCensorMode;
    }
    if (typeof v.replacement === "string") entry.replacement = v.replacement.slice(0, 40);
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

/** Serialise back, dropping empty entries so the column does not accumulate
 *  `{}` for every word the user merely looked at. Returns null when nothing is
 *  overridden, so "no overrides" is one value rather than two. */
export function serializeWordOverrides(overrides: CensorWordOverrides): string | null {
  const out: CensorWordOverrides = {};
  for (const [id, entry] of Object.entries(overrides)) {
    if (!entry) continue;
    const kept: CensorWordOverride = {};
    if (entry.audioMode) kept.audioMode = entry.audioMode;
    if (entry.captionMode) kept.captionMode = entry.captionMode;
    if (entry.replacement != null && entry.replacement !== "") kept.replacement = entry.replacement;
    if (Object.keys(kept).length > 0) out[id] = kept;
  }
  return Object.keys(out).length === 0 ? null : JSON.stringify(out);
}
