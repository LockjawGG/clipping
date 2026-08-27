import { ProviderUnavailableError, type AnalysisProvider } from "../providers/types.ts";
import { env } from "../env.ts";
import { HeuristicAnalysisProvider } from "./heuristic.ts";
import { AnthropicAnalysisProvider } from "./anthropic.ts";
import { OpenAiAnalysisProvider } from "./openai.ts";

export { HeuristicAnalysisProvider } from "./heuristic.ts";
export { AnthropicAnalysisProvider } from "./anthropic.ts";
export { OpenAiAnalysisProvider } from "./openai.ts";
export { refineSuggestions, type RefineOptions } from "./pipeline.ts";
export {
  ANALYSIS_SYSTEM_PROMPT,
  buildTranscriptText,
  buildUserPrompt,
  parseClipArray,
  CLIP_TOOL_NAME,
} from "./prompt.ts";

let cached: AnalysisProvider | undefined;

function build(): AnalysisProvider {
  switch (env.ANALYSIS_PROVIDER) {
    case "anthropic":
      if (!env.ANTHROPIC_API_KEY) {
        throw new ProviderUnavailableError("analysis:anthropic", "set ANTHROPIC_API_KEY");
      }
      return new AnthropicAnalysisProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANALYSIS_MODEL,
      });

    case "openai":
      if (!env.OPENAI_API_KEY) {
        throw new ProviderUnavailableError("analysis:openai", "set OPENAI_API_KEY");
      }
      return new OpenAiAnalysisProvider({
        apiKey: env.OPENAI_API_KEY,
        model: env.ANALYSIS_MODEL,
      });

    case "heuristic":
    default:
      return new HeuristicAnalysisProvider();
  }
}

/** The configured analysis provider. Constructed once, on first call. */
export function getAnalysis(): AnalysisProvider {
  return (cached ??= build());
}

/** Test seam: drop the memoised provider. */
export function resetAnalysis(): void {
  cached = undefined;
}
