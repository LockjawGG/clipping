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

/**
 * Packs answer "what am I making?" — orthogonal to `category`, which answers
 * "what does this look like?". A pack pulls templates from several categories
 * by design; every template belongs to exactly one pack.
 */
export type CaptionTemplatePack =
  | "podcast"
  | "shorts"
  | "gaming"
  | "film"
  | "lifestyle"
  | "hype";

export const CAPTION_TEMPLATE_PACKS: {
  id: CaptionTemplatePack;
  label: string;
  blurb: string;
}[] = [
  {
    id: "podcast",
    label: "Podcast & Interview",
    blurb: "Calm, legible captions that sit quietly under talking heads.",
  },
  {
    id: "shorts",
    label: "Shorts & Reels",
    blurb: "Word-by-word energy built for vertical feeds.",
  },
  {
    id: "gaming",
    label: "Gaming & Streaming",
    blurb: "Glow and alert colours that stay readable over busy gameplay.",
  },
  {
    id: "film",
    label: "Film & Trailer",
    blurb: "Restrained, wide-set type with a cinema-title feel.",
  },
  {
    id: "lifestyle",
    label: "Beauty & Lifestyle",
    blurb: "Soft gradients and light, airy type.",
  },
  {
    id: "hype",
    label: "Hype & Promo",
    blurb: "Loud metallic and high-impact type for drops and offers.",
  },
];

export interface CaptionTemplate {
  id: string;
  category: CaptionTemplateCategory;
  pack: CaptionTemplatePack;
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
    pack: "podcast",
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
    pack: "podcast",
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
    pack: "lifestyle",
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
    pack: "podcast",
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
    pack: "podcast",
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
    pack: "hype",
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
    pack: "hype",
    name: "Hard Yellow",
    animation: "NONE",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 72,
      textColor: YELLOW,
      highlightColor: WHITE,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 12,
      positionY: 0.76,
    },
  },
  {
    id: "bold-long-shadow",
    category: "bold",
    pack: "shorts",
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
    pack: "hype",
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
    pack: "shorts",
    name: "Block Fill",
    animation: "WORD_BY_WORD",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 64,
      textColor: BLACK,
      highlightColor: "#E11D48",
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
    pack: "shorts",
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
    pack: "shorts",
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
    pack: "gaming",
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
    pack: "shorts",
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
    pack: "shorts",
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
    pack: "shorts",
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
    pack: "gaming",
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
    pack: "gaming",
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
    pack: "lifestyle",
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
    pack: "gaming",
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
    pack: "lifestyle",
    name: "Sunset",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 4,
      fill: { kind: "linear-gradient", stops: ["#FFD166", "#EF476F"], angleDeg: 180 },
      positionY: 0.74,
    },
  },
  {
    id: "gradient-ocean",
    category: "gradient",
    pack: "lifestyle",
    name: "Ocean",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 4,
      fill: { kind: "linear-gradient", stops: ["#8AB4FF", "#22D3EE", "#34D399"], angleDeg: 160 },
      positionY: 0.74,
    },
  },
  {
    id: "gradient-gold",
    category: "gradient",
    pack: "hype",
    name: "Gold",
    animation: "POP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: "#3A2A00",
      outlineWidthPx: 4,
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
    pack: "film",
    name: "Silver",
    animation: "POP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: "#1a1a1a",
      outlineWidthPx: 4,
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
    pack: "hype",
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
    pack: "podcast",
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
    pack: "film",
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
    pack: "podcast",
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
    pack: "film",
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

  // ---------- clean (more) ----------
  {
    id: "clean-rounded",
    category: "clean",
    pack: "lifestyle",
    name: "Rounded",
    animation: "FADE",
    style: {
      fontFamily: "Inter",
      fontWeight: 700,
      fontSizePx: 50,
      textColor: WHITE,
      outlineWidthPx: 0,
      backgroundColor: "#1B1B22",
      positionY: 0.82,
    },
  },
  {
    id: "clean-shadow-only",
    category: "clean",
    pack: "podcast",
    name: "Shadow Only",
    animation: "NONE",
    style: {
      fontFamily: "Inter",
      fontWeight: 700,
      fontSizePx: 56,
      textColor: WHITE,
      outlineWidthPx: 0,
      layers: [{ kind: "shadow-soft", color: BLACK, size: 14, opacity: 0.65 }],
      positionY: 0.8,
    },
  },
  {
    id: "clean-tight-caps",
    category: "clean",
    pack: "gaming",
    name: "Tight Caps",
    animation: "NONE",
    style: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePx: 50,
      letterSpacingEm: -0.02,
      textTransform: "uppercase",
      textColor: WHITE,
      outlineColor: BLACK,
      outlineWidthPx: 5,
      positionY: 0.8,
    },
  },
  {
    id: "clean-newsroom",
    category: "clean",
    pack: "podcast",
    name: "Newsroom",
    animation: "NONE",
    style: {
      fontFamily: "Georgia",
      fontWeight: 700,
      fontSizePx: 46,
      textColor: WHITE,
      outlineWidthPx: 0,
      backgroundColor: "#0A2A66",
      positionY: 0.84,
    },
  },

  // ---------- bold (more) ----------
  {
    id: "bold-outline",
    category: "bold",
    pack: "film",
    name: "Outline",
    animation: "POP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 72,
      textColor: "#101014",
      textTransform: "uppercase",
      outlineColor: WHITE,
      outlineWidthPx: 12,
      positionY: 0.75,
    },
  },
  {
    id: "bold-two-tone",
    category: "bold",
    pack: "shorts",
    name: "Two Tone",
    animation: "WORD_BY_WORD",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textColor: WHITE,
      highlightColor: "#FF3B3B",
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 9,
      positionY: 0.74,
    },
    wordRules: [{ trigger: "active", effect: { color: "#FF3B3B" } }],
  },
  {
    id: "bold-sports",
    category: "bold",
    pack: "gaming",
    name: "Sports",
    animation: "SCALE",
    style: {
      fontFamily: "Impact",
      fontWeight: 900,
      fontSizePx: 78,
      letterSpacingEm: 0.02,
      textColor: "#FFD200",
      highlightColor: WHITE,
      textTransform: "uppercase",
      outlineColor: "#0A1A3F",
      outlineWidthPx: 11,
      positionY: 0.73,
    },
  },
  {
    id: "bold-stacked",
    category: "bold",
    pack: "shorts",
    name: "Stacked",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 60,
      lineHeight: 0.98,
      textTransform: "uppercase",
      textColor: WHITE,
      outlineColor: BLACK,
      outlineWidthPx: 8,
      positionY: 0.7,
    },
  },

  // ---------- viral (more) ----------
  {
    id: "viral-red-alert",
    category: "viral",
    pack: "gaming",
    name: "Red Alert",
    animation: "POP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 64,
      textColor: WHITE,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 9,
      positionY: 0.72,
    },
    wordRules: [
      { trigger: "active", effect: { background: "#E11D48", color: WHITE } },
      { trigger: "emphasis", effect: { scale: 1.18, bold: true } },
    ],
  },
  {
    id: "viral-beast",
    category: "viral",
    pack: "hype",
    name: "Big Yellow",
    animation: "BOUNCE",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 70,
      textColor: "#FFE600",
      highlightColor: WHITE,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 12,
      layers: [{ kind: "shadow-hard", color: BLACK, size: 6 }],
      positionY: 0.71,
    },
  },
  {
    id: "viral-bubble",
    category: "viral",
    pack: "shorts",
    name: "Bubble",
    animation: "POP",
    style: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePx: 58,
      textColor: "#1B1B22",
      textTransform: "uppercase",
      outlineColor: WHITE,
      outlineWidthPx: 8,
      backgroundColor: "#FFFFFF",
      positionY: 0.73,
    },
  },
  {
    id: "viral-split",
    category: "viral",
    pack: "shorts",
    name: "Split Color",
    animation: "WORD_BY_WORD",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 60,
      textColor: WHITE,
      highlightColor: "#22D3EE",
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 8,
      positionY: 0.73,
    },
    wordRules: [{ trigger: "spoken", effect: { color: "#22D3EE" } }],
  },

  // ---------- neon (more) ----------
  {
    id: "neon-green",
    category: "neon",
    pack: "gaming",
    name: "Green Tube",
    animation: "FADE",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 62,
      textColor: WHITE,
      textTransform: "uppercase",
      outlineWidthPx: 0,
      layers: [
        { kind: "outline", color: "#39FF88", size: 2 },
        { kind: "neon", color: "#39FF88", size: 9 },
      ],
      positionY: 0.74,
    },
  },
  {
    id: "neon-white",
    category: "neon",
    pack: "lifestyle",
    name: "White Glow",
    animation: "SCALE",
    style: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePx: 58,
      textColor: WHITE,
      outlineWidthPx: 0,
      layers: [{ kind: "glow", color: WHITE, size: 14 }],
      positionY: 0.77,
    },
  },
  {
    id: "neon-violet",
    category: "neon",
    pack: "lifestyle",
    name: "Violet Haze",
    animation: "WORD_BY_WORD",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 60,
      textColor: "#F3E8FF",
      textTransform: "uppercase",
      outlineWidthPx: 0,
      layers: [{ kind: "glow", color: "#A855F7", size: 16 }],
      positionY: 0.75,
    },
  },
  {
    id: "neon-retro",
    category: "neon",
    pack: "film",
    name: "Retro",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Impact",
      fontWeight: 900,
      fontSizePx: 64,
      textTransform: "uppercase",
      outlineWidthPx: 0,
      fill: { kind: "linear-gradient", stops: ["#FF6BCB", "#FFC46B"], angleDeg: 180 },
      layers: [{ kind: "neon", color: "#FF6BCB", size: 8 }],
      positionY: 0.74,
    },
  },

  // ---------- gradient (more) ----------
  {
    id: "gradient-fire",
    category: "gradient",
    pack: "hype",
    name: "Fire",
    animation: "POP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: BLACK,
      outlineWidthPx: 4,
      fill: { kind: "linear-gradient", stops: ["#FFE066", "#FF7A00", "#E11D48"], angleDeg: 175 },
      positionY: 0.74,
    },
  },
  {
    id: "gradient-ice",
    category: "gradient",
    pack: "gaming",
    name: "Ice",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Archivo Black",
      fontWeight: 900,
      fontSizePx: 66,
      textTransform: "uppercase",
      outlineColor: "#0A2540",
      outlineWidthPx: 4,
      fill: { kind: "linear-gradient", stops: ["#FFFFFF", "#BEE3F8", "#63B3ED"], angleDeg: 165 },
      layers: [{ kind: "glow", color: "#BEE3F8", size: 10 }],
      positionY: 0.74,
    },
  },
  {
    id: "gradient-rainbow",
    category: "gradient",
    pack: "hype",
    name: "Rainbow",
    animation: "BOUNCE",
    style: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePx: 62,
      textTransform: "uppercase",
      outlineColor: WHITE,
      outlineWidthPx: 4,
      fill: {
        kind: "linear-gradient",
        stops: ["#FF5F6D", "#FFC371", "#47E891", "#5B7CFA", "#B24BF3"],
        angleDeg: 90,
      },
      positionY: 0.73,
    },
  },
  {
    id: "gradient-pastel",
    category: "gradient",
    pack: "lifestyle",
    name: "Pastel",
    animation: "FADE",
    style: {
      fontFamily: "Inter",
      fontWeight: 700,
      fontSizePx: 56,
      outlineWidthPx: 0,
      fill: { kind: "linear-gradient", stops: ["#FBCFE8", "#C7D2FE"], angleDeg: 160 },
      layers: [{ kind: "shadow-soft", color: BLACK, size: 8, opacity: 0.4 }],
      positionY: 0.8,
    },
  },

  // ---------- cinematic (more) ----------
  {
    id: "cine-trailer",
    category: "cinematic",
    pack: "film",
    name: "Trailer",
    animation: "FADE",
    style: {
      fontFamily: "Georgia",
      fontWeight: 700,
      fontSizePx: 48,
      letterSpacingEm: 0.14,
      textTransform: "uppercase",
      textColor: WHITE,
      outlineWidthPx: 0,
      layers: [{ kind: "shadow-soft", color: BLACK, size: 14, opacity: 0.7 }],
      positionY: 0.82,
    },
  },
  {
    id: "cine-broadcast",
    category: "cinematic",
    pack: "podcast",
    name: "Broadcast",
    animation: "SLIDE_UP",
    style: {
      fontFamily: "Inter",
      fontWeight: 600,
      fontSizePx: 40,
      letterSpacingEm: 0.03,
      textColor: WHITE,
      outlineWidthPx: 0,
      backgroundColor: "#0B0B0F",
      positionY: 0.88,
    },
  },
  {
    id: "cine-noir",
    category: "cinematic",
    pack: "film",
    name: "Noir",
    animation: "FADE",
    style: {
      fontFamily: "Georgia",
      fontWeight: 400,
      fontSizePx: 46,
      letterSpacingEm: 0.05,
      textColor: "#EDEDED",
      outlineWidthPx: 0,
      layers: [{ kind: "shadow-long", color: BLACK, size: 10, angleDeg: 135 }],
      positionY: 0.84,
    },
  },
  {
    id: "cine-whisper",
    category: "cinematic",
    pack: "film",
    name: "Whisper",
    animation: "TYPEWRITER",
    style: {
      fontFamily: "Georgia",
      fontWeight: 400,
      fontSizePx: 42,
      letterSpacingEm: 0.04,
      textColor: "#F2F2F2",
      outlineWidthPx: 0,
      layers: [{ kind: "shadow-soft", color: BLACK, size: 10, opacity: 0.55 }],
      positionY: 0.85,
    },
  },
];

export function templatesByCategory(category: CaptionTemplateCategory): CaptionTemplate[] {
  return CAPTION_TEMPLATES.filter((t) => t.category === category);
}

export function templatesByPack(pack: CaptionTemplatePack): CaptionTemplate[] {
  return CAPTION_TEMPLATES.filter((t) => t.pack === pack);
}

export function findTemplate(id: string): CaptionTemplate | undefined {
  return CAPTION_TEMPLATES.find((t) => t.id === id);
}
