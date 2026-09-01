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
import { emitTelemetry, estimateTokensAvoided } from "@/lib/telemetry/emit.ts";
import type { TelemetryDb } from "@/lib/telemetry/types.ts";

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
      select: { startMs: true, endMs: true, text: true },
    }),
    db.clip.findMany({
      where: { videoId: video.id },
      orderBy: { startMs: "asc" },
      select: { title: true, startMs: true, endMs: true, origin: true },
    }),
  ]);

  // Fallback duration from the last segment's END - its start undercounts by
  // a whole segment and made valid end-of-video proposals look out of range.
  const durationMs = video.durationMs ?? (segments.at(-1)?.endMs ?? 0) + 1000;
  const system = assistantSystemPrompt({
    videoTitle: video.originalFilename ?? "Untitled video",
    durationMs,
    transcript: transcriptForPrompt(segments),
    clips: clips
      .map((c) => `${mmss(c.startMs)}-${mmss(c.endMs)} "${c.title}" (${c.origin})`)
      .join("\n"),
    styleInstructions: prefs.styleInstructions,
  });

  const call = await ollamaChat({
    baseUrl: env.OLLAMA_BASE_URL,
    model,
    system,
    messages: input.messages,
    format: "json",
    // Room for a multi-proposal reply. qwen2.5:14b was observed stopping at
    // ~256 tokens — two clips into a three-clip answer — with no budget set.
    numPredict: 4096,
    // A closed tab must cancel the generation: Ollama runs one generation at a
    // time, so an abandoned turn would queue the user's next question behind it.
    signal: req.signal,
  });

  // Ollama's own token counts, so /brain can show what this turn really cost.
  // Not awaited: telemetry must never sit between the model and the user.
  void emitTelemetry(db as unknown as TelemetryDb, {
    source: "clipper",
    eventType: "llm.request.completed",
    actor: `ollama:${model}`,
    summary: "assistant chat turn",
    model,
    taskId: video.id,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    latencyMs: call.latencyMs,
    // Overhead 0 — the whole turn ran on this machine, so none of it would
    // ever have reached a top-tier model. Left undefined when Ollama reported
    // no counts: "unknown" and "zero" must not look the same on the page.
    estimatedTokensAvoided:
      call.inputTokens === undefined && call.outputTokens === undefined
        ? undefined
        : estimateTokensAvoided({
            workerInput: call.inputTokens,
            workerOutput: call.outputTokens,
            orchestratorOverhead: 0,
          }),
    meta: {
      turns: input.messages.length,
      ...(call.doneReason ? { doneReason: call.doneReason } : {}),
    },
  });

  // A budget-truncated reply is a broken reply, whatever the JSON parser makes
  // of the fragment. Say what actually happened rather than shipping half.
  if (call.doneReason === "length") {
    throw new ApiError(502, "the model ran out of reply budget mid-answer — ask again, or for less at once");
  }

  return Response.json({ model, ...parseAssistantReply(call.content, durationMs) });
});
