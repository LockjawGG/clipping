/**
 * Caption masking: how a censored word is written on screen.
 *
 * Pure string work, deliberately separate from detection so the two can be
 * tested and changed independently. Surrounding punctuation is preserved —
 * masking "shit," to "****" and losing the comma reads as a transcription bug.
 */

export type CaptionCensorMode = "FULL" | "PARTIAL" | "FIRST" | "CUSTOM";

export const CAPTION_CENSOR_MODES: { id: CaptionCensorMode; label: string; sample: string }[] = [
  { id: "FULL", label: "Full mask", sample: "****" },
  { id: "PARTIAL", label: "Keep first + last", sample: "s**t" },
  { id: "FIRST", label: "First letter only", sample: "s***" },
  { id: "CUSTOM", label: "Replace with…", sample: "[BLEEP]" },
];

const MASK_CHAR = "*";

/** Split a token into leading punctuation, letter core, trailing punctuation. */
function split(text: string): { lead: string; core: string; tail: string } {
  const lead = text.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? "";
  const tail = text.match(/[^\p{L}\p{N}]*$/u)?.[0] ?? "";
  const core = text.slice(lead.length, text.length - tail.length);
  return { lead, core, tail };
}

/**
 * Mask one word. Length is preserved for the star modes so a caption's line
 * breaks do not shift when censoring is toggled on.
 */
export function maskWord(text: string, mode: CaptionCensorMode, replacement?: string): string {
  const { lead, core, tail } = split(text);
  if (!core) return text;

  let masked: string;
  switch (mode) {
    case "CUSTOM": {
      const r = (replacement ?? "").trim();
      // An empty custom replacement would silently delete the word; fall back
      // to a full mask rather than dropping it from the caption.
      masked = r || MASK_CHAR.repeat(core.length);
      break;
    }
    case "FIRST":
      masked = core[0] + MASK_CHAR.repeat(Math.max(0, core.length - 1));
      break;
    case "PARTIAL":
      // Needs a first and a last to keep; anything shorter degrades to FIRST,
      // otherwise "at" would come back unmasked as "at".
      masked =
        core.length >= 4
          ? core[0] + MASK_CHAR.repeat(core.length - 2) + core[core.length - 1]
          : core[0] + MASK_CHAR.repeat(Math.max(0, core.length - 1));
      break;
    case "FULL":
    default:
      masked = MASK_CHAR.repeat(core.length);
      break;
  }
  return `${lead}${masked}${tail}`;
}

/** Apply masking to a word list by index — the shape captions are built from. */
export function maskWords<T extends { text: string }>(
  words: readonly T[],
  indices: ReadonlySet<number>,
  mode: CaptionCensorMode,
  replacement?: string,
  /** Per-index settings that win over the clip's `mode` / `replacement`. A word
   *  with no entry, or an entry missing a field, falls back to them. */
  overrides?: ReadonlyMap<number, { mode?: CaptionCensorMode; replacement?: string | null }>,
): T[] {
  if (indices.size === 0) return words as T[];
  return words.map((w, i) => {
    if (!indices.has(i)) return w;
    const own = overrides?.get(i);
    return {
      ...w,
      text: maskWord(
        w.text,
        own?.mode ?? mode,
        own?.replacement ?? replacement,
      ),
    };
  });
}
