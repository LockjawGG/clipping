import {
  ProviderUnavailableError,
  type AnalysisProvider,
  type AnalyzeOptions,
  type ClipSuggestion,
  type Segment,
} from "../providers/types.ts";
import { ollamaChat, ollamaStatus, pickModel, type OllamaOptions } from "../llm/ollama.ts";
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

    const raw = await ollamaChat({
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
