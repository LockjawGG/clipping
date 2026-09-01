import {
  ProviderUnavailableError,
  type AnalysisProvider,
  type AnalyzeOptions,
  type ClipSuggestion,
  type Segment,
} from "../providers/types.ts";
import { ollamaChat, ollamaStatus, pickModel, type OllamaOptions } from "../llm/ollama.ts";
import { estimateTokensAvoided } from "../telemetry/emit.ts";
import type { TelemetryEventInput } from "../telemetry/types.ts";
import { ANALYSIS_SYSTEM_PROMPT, buildUserPrompt, parseClipArray } from "./prompt.ts";

/**
 * Clip suggestions from a local model via Ollama.
 *
 * Same prompt and same output contract as the cloud providers, so the rest of
 * the pipeline cannot tell which brain produced a suggestion. Local models do
 * not get tool calling reliably, so the reply is constrained to JSON with
 * Ollama's `format` option and parsed with the shared validator.
 */
export interface OllamaAnalysisOptions extends OllamaOptions {
  /** Preferred model; any installed model is used when this one is absent. */
  model?: string;
  /**
   * Called once per completed model call with a ready-made telemetry event.
   *
   * A callback rather than a database handle on purpose: this provider is
   * constructed in tests and in the worker alike, and giving it Prisma would
   * drag a connection pool into both. The factory in ./index.ts is the one
   * place that knows about `db` and wires this through to `emitTelemetry`;
   * everywhere else the provider stays exactly as measurable as before, which
   * is to say silent.
   */
  onTelemetry?: (event: TelemetryEventInput) => void;
}

export class OllamaAnalysisProvider implements AnalysisProvider {
  readonly name = "ollama";

  private readonly opts: OllamaAnalysisOptions;

  constructor(opts: OllamaAnalysisOptions = {}) {
    this.opts = opts;
  }

  async suggestClips(segments: Segment[], options: AnalyzeOptions): Promise<ClipSuggestion[]> {
    if (segments.length === 0) return [];

    const status = await ollamaStatus(this.opts);
    if (!status.available) {
      throw new ProviderUnavailableError(
        "analysis:ollama",
        "no Ollama server at its default port — install it from ollama.com and pull a model",
      );
    }
    const model = pickModel(this.opts.model ?? "", status.models);
    if (!model) {
      throw new ProviderUnavailableError(
        "analysis:ollama",
        'Ollama is running but has no models — run e.g. "ollama pull llama3.2"',
      );
    }

    const call = await ollamaChat({
      baseUrl: this.opts.baseUrl,
      model,
      system:
        `${ANALYSIS_SYSTEM_PROMPT}\n\n` +
        `Reply with a single JSON object of the shape {"clips": [...]} and nothing else. ` +
        `Each clip needs: startMs, endMs, title, hook, description, reason, caption, ` +
        `socialTitle, hashtags (array of strings), score (0..1).`,
      messages: [{ role: "user", content: buildUserPrompt(segments, options) }],
      format: "json",
      signal: options.signal,
    });

    // Reported before parsing: the call happened and cost what it cost even if
    // the model then hands back unusable JSON, and a page that only showed
    // successful turns would understate what the machine actually did.
    this.opts.onTelemetry?.({
      source: "clipper",
      eventType: "llm.request.completed",
      actor: `ollama:${model}`,
      summary: "clip suggestions",
      model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      latencyMs: call.latencyMs,
      // Overhead 0: this ran entirely on the user's machine, so none of it
      // passed through a top-tier model to begin with. Left undefined when
      // the server reported no counts — an unknown saving, not a zero one.
      estimatedTokensAvoided:
        call.inputTokens === undefined && call.outputTokens === undefined
          ? undefined
          : estimateTokensAvoided({
              workerInput: call.inputTokens,
              workerOutput: call.outputTokens,
              orchestratorOverhead: 0,
            }),
      meta: { segments: segments.length },
    });

    const raw = call.content;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`ollama returned non-JSON despite format=json: ${raw.slice(0, 200)}`);
    }
    // Small local models sometimes emit the bare array; accept it.
    if (Array.isArray(parsed)) parsed = { clips: parsed };
    return parseClipArray(parsed);
  }
}

/**
 * Try the local model, fall back to the given provider when it is not there.
 *
 * This is what the desktop build runs: with Ollama installed the suggestions
 * get a real language model; without it the app behaves exactly as before.
 * Only *unavailability* falls through — a reachable model that errors is a
 * real failure the user should see, not silently paper over.
 */
export class OllamaWithFallbackProvider implements AnalysisProvider {
  readonly name = "ollama+fallback";

  private readonly primary: OllamaAnalysisProvider;
  private readonly fallback: AnalysisProvider;

  constructor(primary: OllamaAnalysisProvider, fallback: AnalysisProvider) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async suggestClips(segments: Segment[], options: AnalyzeOptions): Promise<ClipSuggestion[]> {
    try {
      return await this.primary.suggestClips(segments, options);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        return this.fallback.suggestClips(segments, options);
      }
      throw err;
    }
  }
}
