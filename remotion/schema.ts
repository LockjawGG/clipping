import { z } from "zod";

export const captionStyleSchema = z.object({
  fontFamily: z.string(),
  fontSizePx: z.number(),
  fontWeight: z.number(),
  textColor: z.string(),
  highlightColor: z.string(),
  outlineColor: z.string(),
  outlineWidthPx: z.number(),
  backgroundColor: z.string().nullable().default(null),
  alignment: z.enum(["left", "center", "right"]).default("center"),
  positionY: z.number(),
  uppercase: z.boolean(),
});

export const remotionWordSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});

export const remotionCueSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  lines: z.array(z.string()),
  words: z.array(remotionWordSchema),
});

export const captionPresetSchema = z.enum([
  "word-by-word",
  "pop",
  "scale",
  "bounce",
  "fade",
  "karaoke",
  "slide-up",
  "typewriter",
]);

/** Rich Text & Captions style + word rules. Validated app-side; the composition
 *  only accepts and forwards them, so these stay permissive. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const textStyleSchema = z.any().nullable().default(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const wordRulesSchema = z.array(z.any()).default([]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const textOverlaysSchema = z.array(z.any()).default([]);
/** Image / GIF layers that carry motion, so ffmpeg's `overlay` filter cannot
 *  composite them. `src` is a `file://` URL to the already-downloaded bytes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const imageOverlaysSchema = z.array(z.any()).default([]);

export const captionedClipSchema = z.object({
  /** `file://…` path to the (already reframed) source video. */
  videoSrc: z.string(),
  /** Whether `videoSrc` is a name inside the bundle rather than a URL. */
  videoIsStatic: z.boolean().default(false),
  cues: z.array(remotionCueSchema),
  preset: captionPresetSchema,
  style: captionStyleSchema,
  textStyle: textStyleSchema,
  wordRules: wordRulesSchema,
  textOverlays: textOverlaysSchema,
  imageOverlays: imageOverlaysSchema,
  fps: z.number(),
  durationInFrames: z.number(),
  width: z.number(),
  height: z.number(),
});

export type CaptionStyleProps = z.infer<typeof captionStyleSchema>;
export type RemotionWord = z.infer<typeof remotionWordSchema>;
export type RemotionCue = z.infer<typeof remotionCueSchema>;
export type CaptionPreset = z.infer<typeof captionPresetSchema>;
export type CaptionedClipProps = z.infer<typeof captionedClipSchema>;

export const DEFAULT_CAPTIONED_CLIP_PROPS: CaptionedClipProps = {
  videoSrc: "",
  videoIsStatic: false,
  cues: [],
  preset: "word-by-word",
  style: {
    fontFamily: "Inter, system-ui, sans-serif",
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
  },
  textStyle: null,
  wordRules: [],
  textOverlays: [],
  imageOverlays: [],
  fps: 30,
  durationInFrames: 900,
  width: 1080,
  height: 1920,
};
