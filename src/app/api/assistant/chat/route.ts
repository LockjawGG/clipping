import { z } from "zod";

import { readJson, route, ApiError } from "@/lib/api/http.ts";
import { getSettings } from "@/lib/api/settings.ts";
import { ollamaChat, ollamaStatus, pickModel } from "@/lib/llm/ollama.ts";
import {
  assistantSystemPrompt,
  parseAssistantReply,
  transcriptForPrompt,
  mmss,
} from "@/lib/assistant/protocol.ts";
import { db } from "@/lib/db.ts";
import { env } from "@/lib/env.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const chatSchema = z.object({
  videoId: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(40),
});

/**
 * POST /api/assistant/chat — one turn with the local model about one video.
 *
 * The server assembles the context (transcript, clips, the user's style
 * rules); the browser only ever sends the conversation. The reply comes back
 * validated: prose plus approved-only proposals, never side effects.
 */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const input = chatSchema.parse(await readJson(req));

  const video = await db.video.findUnique({
    where: { id: input.videoId },
    select: {
      id: true,
      originalFilename: true,
      durationMs: true,
      project: { select: { userId: true } },
    },
  });
  if (!video || video.project.userId !== userId) throw new ApiError(404, "video not found");

  const status = await ollamaStatus({ baseUrl: env.OLLAMA_BASE_URL });
  if (!status.available) {
    throw new ApiError(503, "no local model — install Ollama from ollama.com, then pull a model");
  }
  const prefs = await getSettings(db, userId);
  const model = pickModel(prefs.assistantModel || env.OLLAMA_MODEL, status.models);
  if (!model) {
    throw new ApiError(503, 'Ollama has no models — run "ollama pull llama3.2" once');
  }

  const [segments, clips] = await Promise.all([
    db.transcriptSegment.findMany({
      where: { transcript: { videoId: video.id, translatedTo: "" } },
      orderBy: { index: "asc" },
      select: { startMs: true, text: true },
    }),
    db.clip.findMany({
      where: { videoId: video.id },
      orderBy: { startMs: "asc" },
      select: { title: true, startMs: true, endMs: true, origin: true },
    }),
  ]);

  const durationMs = video.durationMs ?? (segments.at(-1)?.startMs ?? 0) + 1000;
  const system = assistantSystemPrompt({
    videoTitle: video.originalFilename ?? "Untitled video",
    durationMs,
    transcript: transcriptForPrompt(segments),
    clips: clips
      .map((c) => `${mmss(c.startMs)}-${mmss(c.endMs)} "${c.title}" (${c.origin})`)
      .join("\n"),
    styleInstructions: prefs.styleInstructions,
  });

  const raw = await ollamaChat({
    baseUrl: env.OLLAMA_BASE_URL,
    model,
    system,
    messages: input.messages,
    format: "json",
  });

  return Response.json({ model, ...parseAssistantReply(raw, durationMs) });
});
