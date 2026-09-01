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
  baseUrl?: string;
  signal?: AbortSignal;
  /** Whole-call ceiling; local models on CPU can be slow. */
  timeoutMs?: number;
}

/**
 * One chat completion, non-streaming.
 *
 * Streaming is a UI nicety the first version does without: a reply that
 * arrives whole is far easier to validate, and edit proposals must be
 * validated before anyone sees an Approve button.
 */
export async function ollamaChat(req: OllamaChatRequest): Promise<string> {
  const base = req.baseUrl ?? OLLAMA_DEFAULT_URL;
  const signals = [AbortSignal.timeout(req.timeoutMs ?? 120_000)];
  if (req.signal) signals.push(req.signal);
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.any(signals),
    body: JSON.stringify({
      model: req.model,
      stream: false,
      ...(req.format ? { format: req.format } : {}),
      messages: [{ role: "system", content: req.system }, ...req.messages],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ollama /api/chat ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { message?: { content?: string } };
  return body.message?.content ?? "";
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
