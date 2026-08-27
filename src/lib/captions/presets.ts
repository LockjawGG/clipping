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
  | "KARAOKE";

export const CAPTION_ANIMATIONS: readonly CaptionAnimation[] = [
  "NONE",
  "WORD_BY_WORD",
  "POP",
  "SCALE",
  "BOUNCE",
  "FADE",
  "KARAOKE",
] as const;

/** True when the preset needs the Remotion path rather than the ffmpeg burn. */
export function isAnimatedPreset(animation: string | null | undefined): boolean {
  return animation !== null && animation !== undefined && animation !== "NONE";
}

/** The string the Remotion `CaptionedClip` composition expects. */
export function remotionPreset(animation: string): "word-by-word" | "pop" | "scale" | "bounce" | "fade" | "karaoke" {
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
  positionY: 0.78,
  uppercase: false,
};
