/**
 * A minimal client for a locally running Ollama server.
 *
 * This is the app's whole local-LLM story: no API key, no cloud, the model
 * runs on the user's own machine and the transcript never leaves it. Nothing
 * here assumes Ollama exists — every caller starts from `ollamaStatus` and
 * degrades politely when the server is absent, because most machines will not
 * have it and the app must be exactly as good as before on those.
 *
 * Only the two endpoints the app needs are wrapped, with fetch and explicit
 * timeouts rather than an SDK: the surface is small enough that a dependency
 * would cost more than it saves.
 */

export interface OllamaOptions {
  /** Server origin, default Ollama's own `http://127.0.0.1:11434`. */
  baseUrl?: string;
}

export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

export interface OllamaStatus {
  available: boolean;
  /** Installed model names, newest first, when available. */
  models: string[];
}

/** Is a server there, and what can it run? Never throws — absence is a state. */
export async function ollamaStatus(opts: OllamaOptions = {}): Promise<OllamaStatus> {
  const base = opts.baseUrl ?? OLLAMA_DEFAULT_URL;
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { available: false, models: [] };
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return {
      available: true,
      models: (body.models ?? []).map((m) => m.name ?? "").filter(Boolean),
    };
  } catch {
    return { available: false, models: [] };
  }
}

export interface OllamaChatRequest {
  model: string;
  /** Injected as the `system` role message — project context rules live here. */
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** "json" makes Ollama constrain the reply to valid JSON. */
  format?: "json";
  /**
   * Generation budget (Ollama `num_predict`). Set explicitly by every caller
   * that expects a long structured reply: the server-side default depends on
   * the model's own template, and a reply silently cut off at that default is
   * exactly the failure this field exists to prevent (observed: qwen2.5:14b
   * stopping at ~256 tokens, two clips into a three-clip answer).
   */
  numPredict?: number;
  baseUrl?: string;
  signal?: AbortSignal;
  /** Whole-call ceiling; local models on CPU can be slow. */
  timeoutMs?: number;
}

/**
 * A completed chat call: the reply, plus what the call cost.
 *
 * The token counts are Ollama's own — `prompt_eval_count` and `eval_count` from
 * the non-streamed response — so they are exact rather than estimated, and both
 * are optional because an older server can omit either. Absent means "not
 * reported", never zero: the Agent Brain page draws that distinction and would
 * otherwise show a confident 0 for a call nobody counted.
 */
export interface OllamaChatResult {
  content: string;
  /** Prompt tokens, as counted by Ollama. */
  inputTokens?: number;
  /** Generated tokens, as counted by Ollama. */
  outputTokens?: number;
  /**
   * Why generation ended, verbatim from Ollama ("stop" = finished naturally,
   * "length" = ran out of budget mid-reply). Undefined on servers that do not
   * report it. Callers must treat "length" as a broken answer, not a short one.
   */
  doneReason?: string;
  /** Wall-clock duration of the whole call, measured here. */
  latencyMs: number;
}

/** A count only counts if it is one; anything else is "not reported". */
function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * One chat completion, non-streaming.
 *
 * Streaming is a UI nicety the first version does without: a reply that
 * arrives whole is far easier to validate, and edit proposals must be
 * validated before anyone sees an Approve button.
 */
export async function ollamaChat(req: OllamaChatRequest): Promise<OllamaChatResult> {
  const base = req.baseUrl ?? OLLAMA_DEFAULT_URL;
  const signals = [AbortSignal.timeout(req.timeoutMs ?? 120_000)];
  if (req.signal) signals.push(req.signal);
  const startedAt = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.any(signals),
    body: JSON.stringify({
      model: req.model,
      stream: false,
      ...(req.format ? { format: req.format } : {}),
      ...(req.numPredict ? { options: { num_predict: req.numPredict } } : {}),
      messages: [{ role: "system", content: req.system }, ...req.messages],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ollama /api/chat ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    done_reason?: string;
  };
  return {
    content: body.message?.content ?? "",
    inputTokens: countOf(body.prompt_eval_count),
    outputTokens: countOf(body.eval_count),
    doneReason: typeof body.done_reason === "string" ? body.done_reason : undefined,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Pick the model to use: the configured one when installed, else the first
 * installed model, else null. Configured-but-missing falls through rather than
 * erroring because "any local model" beats "no assistant" for every feature
 * this app puts behind one.
 */
export function pickModel(configured: string, installed: readonly string[]): string | null {
  if (installed.length === 0) return null;
  if (configured) {
    const hit = installed.find((m) => m === configured || m.startsWith(`${configured}:`));
    if (hit) return hit;
  }
  return installed[0];
}
