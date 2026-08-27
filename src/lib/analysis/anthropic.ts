import Anthropic from "@anthropic-ai/sdk";

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

export interface AnthropicAnalysisOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export class AnthropicAnalysisProvider implements AnalysisProvider {
  readonly name = "anthropic";

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicAnalysisOptions) {
    if (!opts.apiKey) {
      throw new ProviderUnavailableError("analysis:anthropic", "ANTHROPIC_API_KEY is not set");
    }
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-opus-5";
    this.maxTokens = opts.maxTokens ?? 8000;
  }

  async suggestClips(segments: Segment[], options: AnalyzeOptions): Promise<ClipSuggestion[]> {
    if (segments.length === 0) return [];

    try {
      // Stream so a long transcript / large response can't hit the HTTP timeout.
      const message = await this.client.messages
        .stream(
          {
            model: this.model,
            max_tokens: this.maxTokens,
            system: ANALYSIS_SYSTEM_PROMPT,
            tools: [
              {
                name: CLIP_TOOL_NAME,
                description: CLIP_TOOL_DESCRIPTION,
                input_schema: CLIP_TOOL_INPUT_SCHEMA as Anthropic.Tool.InputSchema,
              },
            ],
            tool_choice: { type: "tool", name: CLIP_TOOL_NAME },
            messages: [{ role: "user", content: buildUserPrompt(segments, options) }],
          },
          { signal: options.signal },
        )
        .finalMessage();

      const call = message.content.find(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === "tool_use" && block.name === CLIP_TOOL_NAME,
      );
      if (!call) {
        throw new Error("model did not return an emit_clips tool call");
      }
      return parseClipArray(call.input);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new ProviderUnavailableError("analysis:anthropic", "ANTHROPIC_API_KEY was rejected");
      }
      throw err;
    }
  }
}
