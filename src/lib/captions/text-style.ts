/**
 * Declarative text-style spec — the styling half of the Text & Captions system
 * (phase 2). A `TextStyle` is plain data: typography, a fill, and an ordered
 * list of effect layers.
 *
 * `textStyleToCss` turns it into inline CSS for the editor preview and the
 * Remotion renderer (both read the same object). `styleNeedsRemotion` decides
 * whether a style is beyond what the fast ffmpeg `force_style` burn can do.
 *
 * Extends the existing `CaptionStyle` so a stored `SubtitleConfig` is a valid
 * partial `TextStyle` with no migration.
 */

import type { CaptionStyle } from "./presets.ts";
import { DEFAULT_CAPTION_STYLE } from "./presets.ts";
import { needsRemotion } from "./anim-spec.ts";

// ---------- fill ----------

export type FillKind = "solid" | "linear-gradient";

export interface Fill {
  kind: FillKind;
  /** solid only. Falls back to the style's `textColor` when absent. */
  color?: string;
  /** gradient only. CSS colour stops, e.g. `["#fff", "#8ab4ff"]`. */
  stops?: string[];
  /** gradient only. Degrees, CSS convention (0 = up). Default 180. */
  angleDeg?: number;
}

// ---------- effect layers ----------

export type EffectLayerKind =
  | "outline"
  | "glow"
  | "neon"
  | "shadow-soft"
  | "shadow-hard"
  | "shadow-long"
  | "emboss"
  | "blur";

export interface EffectLayer {
  kind: EffectLayerKind;
  color?: string;
  /** px. Meaning depends on kind: stroke width / blur radius / offset / length. */
  size?: number;
  /** hard & long shadows: direction in degrees (0 = up, 90 = right). Default 135. */
  angleDeg?: number;
  /** 0..1. Default 1. */
  opacity?: number;
}

/** Effects the ffmpeg `force_style` burn cannot reproduce -> force the Remotion path. */
export const EFFECT_NEEDS_REMOTION: Record<EffectLayerKind, boolean> = {
  outline: false,
  "shadow-soft": false,
  "shadow-hard": false,
  glow: true,
  neon: true,
  "shadow-long": true,
  emboss: true,
  blur: true,
};

// ---------- the style ----------

export interface TextStyle extends CaptionStyle {
  letterSpacingEm: number;
  lineHeight: number;
  textTransform: "none" | "uppercase" | "lowercase" | "capitalize";
  fill: Fill;
  layers: EffectLayer[];
  /** Frosted panel behind the text (distinct from the opaque `backgroundColor` box). */
  glass: boolean;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  ...DEFAULT_CAPTION_STYLE,
  letterSpacingEm: 0,
  lineHeight: 1.15,
  textTransform: "none",
  fill: { kind: "solid" },
  layers: [],
  glass: false,
};

/** Fill in defaults; `fill` and `layers` are replaced wholesale when present. */
export function resolveTextStyle(partial: Partial<TextStyle> | null | undefined): TextStyle {
  const p = partial ?? {};
  return {
    ...DEFAULT_TEXT_STYLE,
    ...p,
    fill: p.fill ?? DEFAULT_TEXT_STYLE.fill,
    layers: p.layers ?? DEFAULT_TEXT_STYLE.layers,
  };
}

// ---------- render-tier decision ----------

export function styleNeedsRemotion(style: Partial<TextStyle> | null | undefined): boolean {
  if (!style) return false;
  if (style.fill && style.fill.kind !== "solid") return true;
  if (style.glass) return true;
  if (style.layers && style.layers.some((l) => EFFECT_NEEDS_REMOTION[l.kind])) return true;
  return false;
}

/** The combined gate the render pipeline uses: animation OR rich style. */
export function captionNeedsRemotion(
  animationId: string | null | undefined,
  style: Partial<TextStyle> | null | undefined,
): boolean {
  return needsRemotion(animationId) || styleNeedsRemotion(style);
}

// ---------- CSS emission ----------

type CssBag = Record<string, string | number>;

export interface TextStyleCss {
  /** Applied to the text element itself. */
  text: CssBag;
  /** Applied to a wrapper panel (opaque box and/or frosted glass). Null when neither. */
  panel: CssBag | null;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Unit vector for a CSS-style angle (0 = up, 90 = right), scaled by `len`. */
function offset(deg: number, len: number): [number, number] {
  return [Math.sin(rad(deg)) * len, -Math.cos(rad(deg)) * len];
}

function layerShadows(layer: EffectLayer): string[] {
  const size = layer.size ?? defaultSize(layer.kind);
  const color = hexToRgba(layer.color ?? "#000000", layer.opacity ?? 1);
  const angle = layer.angleDeg ?? 135;
  switch (layer.kind) {
    case "glow":
      return [`0 0 ${round(size)}px ${color}`, `0 0 ${round(size * 2)}px ${color}`];
    case "neon":
      return [
        `0 0 ${round(size)}px ${color}`,
        `0 0 ${round(size * 2)}px ${color}`,
        `0 0 ${round(size * 4)}px ${color}`,
      ];
    case "shadow-soft":
      return [`0 ${round(size * 0.4)}px ${round(size)}px ${color}`];
    case "shadow-hard": {
      const [dx, dy] = offset(angle, size);
      return [`${round(dx)}px ${round(dy)}px 0 ${color}`];
    }
    case "shadow-long": {
      const steps = Math.min(24, Math.max(1, Math.round(size)));
      const [ux, uy] = offset(angle, 1);
      return Array.from({ length: steps }, (_, i) => `${round(ux * (i + 1))}px ${round(uy * (i + 1))}px 0 ${color}`);
    }
    case "emboss": {
      const d = Math.max(1, size / 2);
      return [
        `${round(d)}px ${round(d)}px 0 rgba(0,0,0,0.45)`,
        `${round(-d)}px ${round(-d)}px 0 rgba(255,255,255,0.35)`,
      ];
    }
    default:
      return [];
  }
}

function defaultSize(kind: EffectLayerKind): number {
  switch (kind) {
    case "outline":
      return 6;
    case "glow":
      return 12;
    case "neon":
      return 8;
    case "shadow-soft":
      return 14;
    case "shadow-hard":
      return 6;
    case "shadow-long":
      return 12;
    case "emboss":
      return 4;
    case "blur":
      return 2;
  }
}

/**
 * `TextStyle` -> inline CSS. `scale` shrinks px units for a small preview box
 * (1 = full frame). Framework-free: values are strings/numbers, cast to
 * `CSSProperties` at the call site.
 */
export function textStyleToCss(style: TextStyle, opts: { scale?: number } = {}): TextStyleCss {
  const scale = opts.scale ?? 1;
  const px = (n: number) => round(n * scale);

  const text: CssBag = {
    fontFamily: `"${style.fontFamily}", Inter, system-ui, sans-serif`,
    fontWeight: style.fontWeight,
    fontSize: `${px(style.fontSizePx)}px`,
    lineHeight: style.lineHeight,
    textAlign: style.alignment,
  };

  if (style.letterSpacingEm) text.letterSpacing = `${style.letterSpacingEm}em`;

  const transform =
    style.textTransform !== "none" ? style.textTransform : style.uppercase ? "uppercase" : "none";
  if (transform !== "none") text.textTransform = transform;

  // fill
  if (style.fill.kind === "linear-gradient" && style.fill.stops && style.fill.stops.length >= 2) {
    const angle = style.fill.angleDeg ?? 180;
    text.backgroundImage = `linear-gradient(${angle}deg, ${style.fill.stops.join(", ")})`;
    text.backgroundClip = "text";
    text.WebkitBackgroundClip = "text";
    text.color = "transparent";
    text.WebkitTextFillColor = "transparent";
  } else {
    text.color = style.fill.color ?? style.textColor;
  }

  // outline: an explicit outline layer wins, else the legacy scalar fields
  const outlineLayer = style.layers.find((l) => l.kind === "outline");
  const outlineW = outlineLayer ? outlineLayer.size ?? defaultSize("outline") : style.outlineWidthPx;
  const outlineC = outlineLayer?.color ?? style.outlineColor;
  if (outlineW > 0) {
    text.WebkitTextStroke = `${px(outlineW)}px ${outlineC}`;
    text.paintOrder = "stroke fill";
  }

  // shadow stack
  const shadows = style.layers.flatMap((l) => (l.kind === "outline" || l.kind === "blur" ? [] : layerShadows(l)));
  if (shadows.length) {
    text.textShadow = shadows.map((s) => scaleShadow(s, scale)).join(", ");
  } else if (!style.backgroundColor && !style.glass) {
    text.textShadow = `0 ${px(4)}px ${px(18)}px rgba(0,0,0,0.55)`;
  }

  // blur on the text itself
  const blurLayer = style.layers.find((l) => l.kind === "blur");
  if (blurLayer) text.filter = `blur(${px(blurLayer.size ?? defaultSize("blur"))}px)`;

  // panel
  let panel: CssBag | null = null;
  if (style.backgroundColor || style.glass) {
    panel = {
      display: "inline-block",
      padding: `${px(style.fontSizePx * 0.12)}px ${px(style.fontSizePx * 0.35)}px`,
      borderRadius: `${px(style.fontSizePx * 0.1)}px`,
    };
    if (style.backgroundColor) panel.background = style.backgroundColor;
    if (style.glass) {
      panel.background = style.backgroundColor ?? "rgba(255,255,255,0.12)";
      panel.backdropFilter = "blur(10px)";
      panel.WebkitBackdropFilter = "blur(10px)";
      panel.border = "1px solid rgba(255,255,255,0.25)";
    }
  }

  return { text, panel };
}

/** Multiply the px magnitudes inside a single `text-shadow` term by `scale`. */
function scaleShadow(term: string, scale: number): string {
  if (scale === 1) return term;
  return term.replace(/(-?\d+(?:\.\d+)?)px/g, (_, n) => `${round(Number(n) * scale)}px`);
}

function round(n: number, dp = 2): number {
  const k = 10 ** dp;
  return Math.round(n * k) / k;
}
