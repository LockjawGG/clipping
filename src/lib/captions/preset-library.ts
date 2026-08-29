/**
 * Built-in caption templates — the content of the Text & Captions browser.
 *
 * Each template is data: a partial `TextStyle`, an animation (enum form, as
 * stored on `SubtitleConfig`), and optional word rules. Applying one writes its
 * fields onto the clip's caption config. Adding a template is a data edit, not
 * a code change.
 */

import type { CaptionAnimation } from "./presets.ts";
import type { TextStyle } from "./text-style.ts";
import type { WordRule } from "./word-rules.ts";

export type CaptionTemplateCategory =
  | "clean"
  | "bold"
  | "viral"
  | "neon"
  | "gradient"
  | "cinematic";

export const CAPTION_TEMPLATE_CATEGORIES: {
  id: CaptionTemplateCategory;
  label: string;
  blurb: string;
}[] = [
  { id: "clean", label: "Clean", blurb: "Legible, unobtrusive, safe on any footage." },
  { id: "bold", label: "Bold", blurb: "Heavy weight, hard outline, high contrast." },
  { id: "viral", label: "Viral", blurb: "Word-by-word pops and highlight boxes." },
  { id: "neon", label: "Neon", blurb: "Glow and neon-tube effects for dark scenes." },
  { id: "gradient", label: "Gradient", blurb: "Multi-colour and metallic fills." },
  { id: "cinematic", label: "Cinematic", blurb: "Lower-third calm — let-spaced, understated." },
];

export interface CaptionTemplate {
  id: string;
  category: CaptionTemplateCategory;
  name: string;
  /** Fields to write onto the clip's caption config. Anything omitted is left as-is. */
  style: Partial<TextStyle>;
  animation: CaptionAnimation;
  wordRules?: WordRule[];
}

const WHITE = "#FFFFFF";
const BLACK = "#000000";
const YELLOW = "#FFE600";
const CYAN = "#00E5FF";

export const CAPTION_TEMPLATES: CaptionTemplate[] = [
  // ---------- clean ----------
  {
    id: "clean-inter",
    category: "clean",
    name: "Inter",
    animation: "NONE",
    style: {
      fontFamily: "Inter",
      fontWeight: 600,
      fontSizePx: 58,
      textColor: WHITE,
      outlineColor: BLACK,
      outlineWidthPx: 5,
      positionY: 0.8,
    },
  },
  {
    id: "clean-caption-box",
    category: "clean",
    name: "Caption Box",
    animation: "NONE",
    style: {
      fontFamily: "Inter",
      fontWeight: 600,
      fontSizePx: 52,
      textColor: WHITE,
      outlineWidthPx: 0,
      backgroundColor: "#101014",
      positionY: 0.82,
    },
  },
  {
    id: "clean-glass",
    category: "clean",
    name: "Frosted",
    animation: "FADE",
    style: {
      fontFamily: "Inter",
      fontWeight: 600,
      fontSizePx: 52,
      textColor: WHITE,
      outlineWidthPx: 0,
      glass: true,
      positionY: 0.8,
    },
  },
  {
    id: "clean-serif",
    category: "clean",
    name: "Editorial",
    animation: "NONE",
    style: {
      fontFamily: "Georgia",
      fontWeight: 700,
      fontSizePx: 54,
      textColor: WHITE,
      outlineColor: BLACK,
      outlineWidthPx: 4,
      positionY: 0.82,
    },
  },
  {
    id: "clean-mono",
    category: "clean",
    name: "Monospace",
    animation: "NONE",
    style: {
      fontFamily: "JetBrains Mono",
      fontWeight: 700,
      fontSizePx: 44,
      letterSpacingEm: -0.01,
      textColor: WHITE,
      outlineColor: BLACK,
      outlineWidthPx: 4,
      positionY: 0.83,
    },
  },

  // ---------- bold ----------
  {
    id: "bold-impact",
    category: "bold",
    name: "Impact",
    animation: "NONE",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 74,
      textColor: WHITE,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 10,
      positionY: 0.76,
    },
  },
  {
    id: "bold-yellow",
    category: "bold",
    name: "Hard Yellow",
    animation: "NONE",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 72,
      textColor: YELLOW,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 12,
      positionY: 0.76,
    },
  },
  {
    id: "bold-long-shadow",
    category: "bold",
    name: "Long Shadow",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 70,
      textColor: WHITE,
      textTransform: "uppercase",
      outlineWidthPx: 0,
      layers: [{ kind: "shadow-long", color: "#1a1a1a", size: 14, angleDeg: 135 }],
      positionY: 0.74,
    },
  },
  {
    id: "bold-emboss",
    category: "bold",
    name: "Emboss",
    animation: "POP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 68,
      textColor: "#D9D9D9",
      outlineWidthPx: 0,
      layers: [{ kind: "emboss", size: 5 }],
      positionY: 0.77,
    },
  },
  {
    id: "bold-block",
    category: "bold",
    name: "Block Fill",
    animation: "WORD_BY_WORD",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 64,
      textColor: BLACK,
      textTransform: "uppercase",
      outlineWidthPx: 0,
      backgroundColor: YELLOW,
      positionY: 0.77,
    },
  },

  // ---------- viral ----------
  {
    id: "viral-pop-yellow",
    category: "viral",
    name: "Pop Yellow",
    animation: "POP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textColor: WHITE,
      highlightColor: YELLOW,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 9,
      positionY: 0.72,
    },
    wordRules: [{ trigger: "active", effect: { color: YELLOW, scale: 1.08 } }],
  },
  {
    id: "viral-highlight-box",
    category: "viral",
    name: "Highlight Box",
    animation: "WORD_BY_WORD",
    style: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePx: 60,
      textColor: WHITE,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 7,
      positionY: 0.74,
    },
    wordRules: [{ trigger: "active", effect: { background: "#7C3AED", color: WHITE } }],
  },
  {
    id: "viral-karaoke",
    category: "viral",
    name: "Karaoke",
    animation: "KARAOKE",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 62,
      textColor: WHITE,
      highlightColor: "#22FF88",
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 8,
      positionY: 0.73,
    },
    wordRules: [{ trigger: "spoken", effect: { color: "#22FF88" } }],
  },
  {
    id: "viral-bounce",
    category: "viral",
    name: "Bounce",
    animation: "BOUNCE",
    style: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePx: 60,
      textColor: WHITE,
      highlightColor: CYAN,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 8,
      positionY: 0.73,
    },
  },
  {
    id: "viral-emphasis",
    category: "viral",
    name: "AI Emphasis",
    animation: "WORD_BY_WORD",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 60,
      textColor: WHITE,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 8,
      positionY: 0.73,
    },
    wordRules: [
      { trigger: "active", effect: { color: YELLOW } },
      { trigger: "emphasis", effect: { scale: 1.2, bold: true, color: "#FF4D4D" } },
    ],
  },
  {
    id: "viral-typewriter",
    category: "viral",
    name: "Typewriter",
    animation: "TYPEWRITER",
    style: {
      fontFamily: "JetBrains Mono",
      fontWeight: 700,
      fontSizePx: 48,
      textColor: WHITE,
      outlineColor: BLACK,
      outlineWidthPx: 5,
      positionY: 0.78,
    },
  },

  // ---------- neon ----------
  {
    id: "neon-cyan",
    category: "neon",
    name: "Cyan Tube",
    animation: "FADE",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 62,
      textColor: WHITE,
      textTransform: "uppercase",
      outlineWidthPx: 0,
      layers: [
        { kind: "outline", color: CYAN, size: 2 },
        { kind: "neon", color: CYAN, size: 9 },
      ],
      positionY: 0.74,
    },
  },
  {
    id: "neon-pink",
    category: "neon",
    name: "Pink Tube",
    animation: "FADE",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 62,
      textColor: WHITE,
      textTransform: "uppercase",
      outlineWidthPx: 0,
      layers: [
        { kind: "outline", color: "#FF4DD2", size: 2 },
        { kind: "neon", color: "#FF4DD2", size: 9 },
      ],
      positionY: 0.74,
    },
  },
  {
    id: "neon-glow-soft",
    category: "neon",
    name: "Soft Glow",
    animation: "SCALE",
    style: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePx: 58,
      textColor: WHITE,
      outlineWidthPx: 0,
      layers: [{ kind: "glow", color: "#8AB4FF", size: 16 }],
      positionY: 0.77,
    },
  },
  {
    id: "neon-amber",
    category: "neon",
    name: "Amber Glow",
    animation: "WORD_BY_WORD",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 60,
      textColor: "#FFF3D6",
      textTransform: "uppercase",
      outlineWidthPx: 0,
      layers: [{ kind: "glow", color: "#FFB020", size: 14 }],
      positionY: 0.75,
    },
  },

  // ---------- gradient ----------
  {
    id: "gradient-sunset",
    category: "gradient",
    name: "Sunset",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 8,
      fill: { kind: "linear-gradient", stops: ["#FFD166", "#EF476F"], angleDeg: 180 },
      positionY: 0.74,
    },
  },
  {
    id: "gradient-ocean",
    category: "gradient",
    name: "Ocean",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 8,
      fill: { kind: "linear-gradient", stops: ["#8AB4FF", "#22D3EE", "#34D399"], angleDeg: 160 },
      positionY: 0.74,
    },
  },
  {
    id: "gradient-gold",
    category: "gradient",
    name: "Gold",
    animation: "POP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: "#3A2A00",
      outlineWidthPx: 6,
      fill: {
        kind: "linear-gradient",
        stops: ["#FFF6C9", "#E9C356", "#B8860B", "#F5E6A8"],
        angleDeg: 175,
      },
      layers: [{ kind: "shadow-soft", color: "#000000", size: 10, opacity: 0.5 }],
      positionY: 0.74,
    },
  },
  {
    id: "gradient-silver",
    category: "gradient",
    name: "Silver",
    animation: "POP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: "#1a1a1a",
      outlineWidthPx: 6,
      fill: {
        kind: "linear-gradient",
        stops: ["#FFFFFF", "#C7CDD6", "#8A929E", "#E8ECF2"],
        angleDeg: 175,
      },
      positionY: 0.74,
    },
  },
  {
    id: "gradient-candy",
    category: "gradient",
    name: "Candy",
    animation: "BOUNCE",
    style: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePx: 62,
      textTransform: "uppercase",
      outlineColor: WHITE,
      outlineWidthPx: 4,
      fill: { kind: "linear-gradient", stops: ["#FF6BCB", "#7C3AED"], angleDeg: 150 },
      positionY: 0.74,
    },
  },

  // ---------- cinematic ----------
  {
    id: "cine-lower-third",
    category: "cinematic",
    name: "Lower Third",
    animation: "FADE",
    style: {
      fontFamily: "Inter",
      fontWeight: 600,
      fontSizePx: 44,
      letterSpacingEm: 0.06,
      textTransform: "uppercase",
      textColor: WHITE,
      outlineWidthPx: 0,
      layers: [{ kind: "shadow-soft", color: BLACK, size: 12, opacity: 0.6 }],
      positionY: 0.86,
    },
  },
  {
    id: "cine-quiet",
    category: "cinematic",
    name: "Quiet",
    animation: "FADE",
    style: {
      fontFamily: "Georgia",
      fontWeight: 400,
      fontSizePx: 46,
      letterSpacingEm: 0.02,
      textColor: "#F2F2F2",
      outlineWidthPx: 0,
      layers: [{ kind: "shadow-soft", color: BLACK, size: 10, opacity: 0.55 }],
      positionY: 0.84,
    },
  },
  {
    id: "cine-doc",
    category: "cinematic",
    name: "Documentary",
    animation: "NONE",
    style: {
      fontFamily: "Inter",
      fontWeight: 500,
      fontSizePx: 42,
      letterSpacingEm: 0.04,
      textColor: WHITE,
      outlineColor: BLACK,
      outlineWidthPx: 3,
      positionY: 0.87,
    },
  },
  {
    id: "cine-spaced-caps",
    category: "cinematic",
    name: "Spaced Caps",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Inter",
      fontWeight: 700,
      fontSizePx: 40,
      letterSpacingEm: 0.22,
      textTransform: "uppercase",
      textColor: WHITE,
      outlineWidthPx: 0,
      layers: [{ kind: "glow", color: "#000000", size: 8, opacity: 0.6 }],
      positionY: 0.8,
    },
  },
];

export function templatesByCategory(category: CaptionTemplateCategory): CaptionTemplate[] {
  return CAPTION_TEMPLATES.filter((t) => t.category === category);
}

export function findTemplate(id: string): CaptionTemplate | undefined {
  return CAPTION_TEMPLATES.find((t) => t.id === id);
}
