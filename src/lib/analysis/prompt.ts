import { z } from "zod";

import type { AnalyzeOptions, ClipSuggestion, Segment } from "../providers/types.ts";
import { clamp01 } from "../transcription/normalize.ts";

/**
 * Shared prompt construction and output parsing for the LLM-backed analysis
 * providers (Anthropic, OpenAI). Both ask the model for the same JSON shape via
 * a single forced tool call, then run the result through `parseClipArray` here.
 *
 * The model's start/end times are treated as a rough guess. `refineSuggestions`
 * (pipeline.ts) snaps them to sentence boundaries afterwards.
 */

function timecode(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Numbered, timestamped transcript the model reads. */
export function buildTranscriptText(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      const speaker = seg.speaker ? ` ${seg.speaker}:` : "";
      return `#${i} [${timecode(seg.startMs)}-${timecode(seg.endMs)}]${speaker} ${seg.text}`;
    })
    .join("\n");
}

export const ANALYSIS_SYSTEM_PROMPT = [
  "You find the strongest short-form clips in a long video transcript.",
  "A good clip is self-contained, opens on a hook, and would make someone stop scrolling.",
  "Favour complete thoughts, emotional peaks, surprising claims, and crisp storytelling.",
  "Avoid clips that depend on earlier context to make sense, and avoid dead air at the edges.",
  "Return your picks with the emit_clips tool. Times are in milliseconds from the start of the video;",
  "approximate boundaries are fine, they are snapped to sentence edges downstream.",
].join(" ");

export function buildUserPrompt(segments: Segment[], options: AnalyzeOptions): string {
  const minS = Math.round(options.minClipMs / 1000);
  const maxS = Math.round(options.maxClipMs / 1000);
  const lines = [
    `Find up to ${options.maxClips} clips, each ${minS}-${maxS} seconds long.`,
    options.style ? `Style / audience: ${options.style}.` : null,
    "",
    "For each clip give: startMs, endMs, title, hook (the scroll-stopping first line),",
    "description, reason (why it works), caption, socialTitle, hashtags (3-6, no '#'),",
    "and score (0-1, your confidence it will perform).",
    "",
    "Transcript:",
    buildTranscriptText(segments),
  ];
  return lines.filter((l) => l !== null).join("\n");
}

const clipSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().positive(),
  title: z.string().min(1),
  hook: z.string().default(""),
  description: z.string().default(""),
  reason: z.string().default(""),
  caption: z.string().default(""),
  socialTitle: z.string().default(""),
  hashtags: z.array(z.string()).default([]),
  score: z.number().default(0.5),
});

/** JSON Schema for the tool input. Shared by the Anthropic and OpenAI providers. */
export const CLIP_TOOL_INPUT_SCHEMA: { type: "object"; [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["startMs", "endMs", "title"],
        properties: {
          startMs: { type: "number", description: "clip start, ms from video start" },
          endMs: { type: "number", description: "clip end, ms from video start" },
          title: { type: "string" },
          hook: { type: "string", description: "scroll-stopping opening line" },
          description: { type: "string" },
          reason: { type: "string", description: "why this clip works" },
          caption: { type: "string" },
          socialTitle: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
          score: { type: "number", description: "0-1 confidence" },
        },
      },
    },
  },
};

export const CLIP_TOOL_NAME = "emit_clips";
export const CLIP_TOOL_DESCRIPTION =
  "Report the chosen clips. Call exactly once with every clip in the `clips` array.";

/** Validate and normalise whatever the model put in the tool call. */
export function parseClipArray(input: unknown): ClipSuggestion[] {
  const parsed = z.object({ clips: z.array(clipSchema) }).parse(input);
  return parsed.clips
    .map((c) => ({
      startMs: Math.round(c.startMs),
      endMs: Math.round(c.endMs),
      title: c.title.trim(),
      hook: c.hook.trim(),
      description: c.description.trim(),
      reason: c.reason.trim(),
      caption: c.caption.trim(),
      socialTitle: (c.socialTitle || c.title).trim(),
      hashtags: c.hashtags.map((h) => h.replace(/^#/, "").trim()).filter(Boolean).slice(0, 8),
      score: clamp01(c.score),
    }))
    .filter((c) => c.endMs > c.startMs);
}
