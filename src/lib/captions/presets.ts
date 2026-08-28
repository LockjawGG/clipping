/**
 * Caption animation presets, mirroring the Prisma `CaptionAnimation` enum.
 *
 * `NONE` burns a plain SRT with ffmpeg's `subtitles=` filter — fast, no browser.
 * Every other preset is word-timed animation and goes through the Remotion
 * renderer instead.
 */
export type CaptionAnimation =
  | "NONE"
  | "WORD_BY_WORD"
  | "POP"
  | "SCALE"
  | "BOUNCE"
  | "FADE"
  | "KARAOKE"
  | "SLIDE_UP"
  | "TYPEWRITER";

export const CAPTION_ANIMATIONS: readonly CaptionAnimation[] = [
  "NONE",
  "WORD_BY_WORD",
  "POP",
  "SCALE",
  "BOUNCE",
  "FADE",
  "KARAOKE",
  "SLIDE_UP",
  "TYPEWRITER",
] as const;

/** True when the preset needs the Remotion path rather than the ffmpeg burn. */
export function isAnimatedPreset(animation: string | null | undefined): boolean {
  return animation !== null && animation !== undefined && animation !== "NONE";
}

export type RemotionCaptionPreset =
  | "word-by-word"
  | "pop"
  | "scale"
  | "bounce"
  | "fade"
  | "karaoke"
  | "slide-up"
  | "typewriter";

/** The string the Remotion `CaptionedClip` composition expects. */
export function remotionPreset(animation: string): RemotionCaptionPreset {
  switch (animation) {
    case "POP":
      return "pop";
    case "SCALE":
      return "scale";
    case "BOUNCE":
      return "bounce";
    case "FADE":
      return "fade";
    case "KARAOKE":
      return "karaoke";
    case "SLIDE_UP":
      return "slide-up";
    case "TYPEWRITER":
      return "typewriter";
    default:
      return "word-by-word";
  }
}

export interface CaptionStyle {
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidthPx: number;
  /** `#rrggbb` for an opaque caption box, or null for outline-only. */
  backgroundColor: string | null;
  alignment: "left" | "center" | "right";
  /** 0..1 from the top of the frame. */
  positionY: number;
  uppercase: boolean;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: "Inter",
  fontSizePx: 64,
  fontWeight: 700,
  textColor: "#FFFFFF",
  highlightColor: "#FFE600",
  outlineColor: "#000000",
  outlineWidthPx: 6,
  backgroundColor: null,
  alignment: "center",
  positionY: 0.78,
  uppercase: false,
};
