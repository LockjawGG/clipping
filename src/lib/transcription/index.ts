import { ProviderUnavailableError, type TranscriptionProvider } from "../providers/types.ts";
import { env } from "../env.ts";
import { WhisperLocalProvider } from "./whisper-local.ts";
import { OpenAiTranscriptionProvider } from "./openai.ts";
import { DeepgramTranscriptionProvider } from "./deepgram.ts";

export { WhisperLocalProvider, parseWhisperJson } from "./whisper-local.ts";
export { OpenAiTranscriptionProvider, parseVerboseJson } from "./openai.ts";
export { DeepgramTranscriptionProvider, parseDeepgramResponse } from "./deepgram.ts";
export * from "./normalize.ts";

let cached: TranscriptionProvider | undefined;

function build(): TranscriptionProvider {
  switch (env.TRANSCRIPTION_PROVIDER) {
    case "openai":
      if (!env.OPENAI_API_KEY) {
        throw new ProviderUnavailableError("transcription:openai", "set OPENAI_API_KEY");
      }
      return new OpenAiTranscriptionProvider({ apiKey: env.OPENAI_API_KEY });

    case "deepgram":
      if (!env.DEEPGRAM_API_KEY) {
        throw new ProviderUnavailableError("transcription:deepgram", "set DEEPGRAM_API_KEY");
      }
      return new DeepgramTranscriptionProvider({ apiKey: env.DEEPGRAM_API_KEY });

    case "whisper-local":
    default:
      // Availability of the binary is checked when transcribe() runs it.
      return new WhisperLocalProvider({
        binary: env.WHISPER_BINARY,
        model: env.WHISPER_MODEL,
        tempDir: env.TEMP_DIR,
      });
  }
}

/** The configured transcription provider. Constructed once, on first call. */
export function getTranscription(): TranscriptionProvider {
  return (cached ??= build());
}

/** Test seam: drop the memoised provider. */
export function resetTranscription(): void {
  cached = undefined;
}
