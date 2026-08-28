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

export const captionedClipSchema = z.object({
  /** `file://…` path to the (already reframed) source video. */
  videoSrc: z.string(),
  cues: z.array(remotionCueSchema),
  preset: captionPresetSchema,
  style: captionStyleSchema,
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
  fps: 30,
  durationInFrames: 900,
  width: 1080,
  height: 1920,
};
