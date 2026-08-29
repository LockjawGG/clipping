/**
 * The "rich half" of a caption style — the fields that live in the
 * `SubtitleConfig.styleJson` blob rather than the scalar columns. Pure
 * parse / serialise so the editor and tests can share it.
 */

import type { EffectLayer, Fill } from "./text-style.ts";

export interface RichExtras {
  letterSpacingEm?: number;
  lineHeight?: number;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  fill?: Fill;
  layers?: EffectLayer[];
  glass?: boolean;
}

export const RICH_DEFAULTS = {
  letterSpacingEm: 0,
  lineHeight: 1.15,
  textTransform: "none" as const,
};

export function parseRich(styleJson: string | null | undefined): RichExtras {
  if (!styleJson) return {};
  try {
    const p = JSON.parse(styleJson);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as RichExtras) : {};
  } catch {
    return {};
  }
}

/**
 * Serialise, dropping any field that is at its default, so a style with no rich
 * extras serialises back to `null` and keeps the fast ffmpeg burn path.
 */
export function serializeRich(r: RichExtras): string | null {
  const out: RichExtras = {};
  if (r.letterSpacingEm && r.letterSpacingEm !== RICH_DEFAULTS.letterSpacingEm) {
    out.letterSpacingEm = r.letterSpacingEm;
  }
  if (r.lineHeight && r.lineHeight !== RICH_DEFAULTS.lineHeight) out.lineHeight = r.lineHeight;
  if (r.textTransform && r.textTransform !== RICH_DEFAULTS.textTransform) {
    out.textTransform = r.textTransform;
  }
  if (r.fill && r.fill.kind !== "solid") out.fill = r.fill;
  if (r.layers && r.layers.length) out.layers = r.layers;
  if (r.glass) out.glass = true;
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
