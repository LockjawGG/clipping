import {
  ProviderUnavailableError,
  type AnalysisProvider,
  type AnalyzeOptions,
  type ClipSuggestion,
  type Segment,
} from "../providers/types.ts";
import {
  ANALYSIS_SYSTEM_PROMPT,
  CLIP_TOOL_DESCRIPTION,
  CLIP_TOOL_INPUT_SCHEMA,
  CLIP_TOOL_NAME,
  buildUserPrompt,
  parseClipArray,
} from "./prompt.ts";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

interface ChatCompletion {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

export interface OpenAiAnalysisOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/** Same prompt + tool contract as the Anthropic provider, over the chat API. */
export class OpenAiAnalysisProvider implements AnalysisProvider {
  readonly name = "openai";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;

  constructor(opts: OpenAiAnalysisOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "gpt-4o";
    this.endpoint = opts.baseUrl ? `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions` : ENDPOINT;
  }

  async suggestClips(segments: Segment[], options: AnalyzeOptions): Promise<ClipSuggestion[]> {
    if (!this.apiKey) {
      throw new ProviderUnavailableError("analysis:openai", "OPENAI_API_KEY is not set");
    }
    if (segments.length === 0) return [];

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(segments, options) },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: CLIP_TOOL_NAME,
              description: CLIP_TOOL_DESCRIPTION,
              parameters: CLIP_TOOL_INPUT_SCHEMA,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: CLIP_TOOL_NAME } },
      }),
      signal: options.signal,
    });

    if (res.status === 401) {
      throw new ProviderUnavailableError("analysis:openai", "OPENAI_API_KEY was rejected (401)");
    }
    if (!res.ok) {
      throw new Error(`OpenAI analysis failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as ChatCompletion;
    const args = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) throw new Error("model did not return an emit_clips tool call");
    return parseClipArray(JSON.parse(args));
  }
}
