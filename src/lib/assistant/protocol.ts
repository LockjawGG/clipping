import { z } from "zod";

/**
 * The assistant's contract with the model and the UI.
 *
 * The model answers as JSON: a conversational `reply`, plus zero or more
 * `proposals` — concrete edits it wants to make. Nothing a model says mutates
 * anything: every proposal renders as a card with Approve and Deny, and only
 * Approve calls the same APIs the user's own hands would. That is the whole
 * yap loop: the machine edits, the human signs off.
 *
 * The action set is deliberately tiny. Two actions that always work beat ten
 * that sometimes do, and each one maps 1:1 onto an existing endpoint so
 * approval cannot invent new behavior.
 */

export const proposalSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_clip"),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    title: z.string().min(1).max(120),
    /** Why this span — shown on the card so approval is informed. */
    reason: z.string().min(1).max(300),
  }),
  z.object({
    action: z.literal("add_censor_word"),
    word: z.string().min(1).max(60),
    reason: z.string().min(1).max(300),
  }),
]);

export type AssistantProposal = z.infer<typeof proposalSchema>;

export interface AssistantReply {
  reply: string;
  proposals: AssistantProposal[];
}

const replySchema = z.object({
  reply: z.string().catch(""),
  proposals: z.array(z.unknown()).catch([]),
});

/**
 * Validate whatever the model produced. Individually bad proposals are dropped
 * rather than failing the reply — a usable answer with three good proposals
 * beats an error because the fourth was malformed.
 */
export function parseAssistantReply(raw: string, videoDurationMs: number): AssistantReply {
  // Small models love to wrap JSON in markdown fences even when told not to
  // (and even with format=json off the happy path). Strip them before parsing.
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    // A model that ignored the JSON instruction still said *something*.
    return { reply: raw.trim().slice(0, 4000), proposals: [] };
  }
  // A bare array is a model that skipped the wrapper; anything else
  // non-object degrades to prose rather than throwing out of the route.
  if (Array.isArray(parsed)) parsed = { reply: "", proposals: parsed };
  const checked = replySchema.safeParse(parsed);
  if (!checked.success) return { reply: raw.trim().slice(0, 4000), proposals: [] };
  const base = checked.data;
  const proposals: AssistantProposal[] = [];
  for (const p of base.proposals) {
    const hit = proposalSchema.safeParse(p);
    if (!hit.success) continue;
    if (hit.data.action === "create_clip") {
      if (hit.data.endMs <= hit.data.startMs) continue;
      if (hit.data.startMs > videoDurationMs) continue;
      // Clamp the end rather than dropping the idea over a rounding overrun -
      // then re-check, because clamping can itself produce an empty range.
      hit.data.endMs = Math.min(hit.data.endMs, videoDurationMs);
      if (hit.data.endMs <= hit.data.startMs) continue;
    }
    if (hit.data.action === "add_censor_word") {
      hit.data.word = hit.data.word.trim().toLowerCase();
      if (!hit.data.word) continue;
    }
    proposals.push(hit.data);
  }
  return { reply: base.reply.trim().slice(0, 4000), proposals: proposals.slice(0, 8) };
}

export interface AssistantContext {
  videoTitle: string;
  durationMs: number;
  /** `[mm:ss] text` transcript lines, already truncated by the builder. */
  transcript: string;
  /** One line per existing clip. */
  clips: string;
  /** The user's "how I edit" instructions, possibly empty. */
  styleInstructions: string;
}

/** System prompt: who the assistant is, what it sees, how it must answer. */
export function assistantSystemPrompt(ctx: AssistantContext): string {
  return [
    "You are the editing assistant inside Clipper, a short-form video editor.",
    "You see one video: its transcript with timestamps, its existing clips, and",
    "the editor's own style rules. Help plan and execute edits.",
    "",
    ctx.styleInstructions
      ? `The editor's style rules (follow them):\n${ctx.styleInstructions}`
      : "The editor has not written style rules yet.",
    "",
    `Video: "${ctx.videoTitle}" (${Math.round(ctx.durationMs / 1000)}s)`,
    `Existing clips:\n${ctx.clips || "(none yet)"}`,
    `Transcript:\n${ctx.transcript || "(no speech)"}`,
    "",
    'Answer as one JSON object: {"reply": "<conversational answer>",',
    '"proposals": [...]}. Propose edits ONLY as proposals — never claim an edit',
    "happened. Allowed proposals:",
    '  {"action":"create_clip","startMs":<int>,"endMs":<int>,"title":"...","reason":"..."}',
    '  {"action":"add_censor_word","word":"...","reason":"..."}',
    "Times are milliseconds within this video. Use empty proposals for a",
    "question that needs no edit. Never propose more than 5 at once.",
  ].join("\n");
}

/** `[mm:ss]` for prompt timestamps — models handle these better than raw ms. */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
}

/**
 * The transcript as prompt text, newest-model-friendly and bounded: a huge
 * podcast is sampled from the start, middle and end rather than truncated
 * blind, so the assistant still knows how the video ends.
 */
export function transcriptForPrompt(
  segments: ReadonlyArray<{ startMs: number; text: string }>,
  maxChars = 9000,
): string {
  const lines = segments.map((sg) => `${mmss(sg.startMs)} ${sg.text.trim()}`);
  const all = lines.join("\n");
  if (all.length <= maxChars) return all;
  const third = Math.floor(maxChars / 3);
  const head: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length > third) break;
    head.push(l);
    used += l.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > third) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  const midStart = Math.floor(lines.length / 2);
  const mid: string[] = [];
  used = 0;
  for (let i = midStart; i < lines.length; i++) {
    if (used + lines[i].length > third) break;
    mid.push(lines[i]);
    used += lines[i].length + 1;
  }
  return [...head, "[…]", ...mid, "[…]", ...tail].join("\n");
}
