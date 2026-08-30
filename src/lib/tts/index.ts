import { ProviderUnavailableError } from "../providers/types.ts";
import { env } from "../env.ts";
import { PiperTtsProvider } from "./piper-local.ts";
import type { TtsProvider } from "./types.ts";

export * from "./types.ts";
export { PiperTtsProvider, parseVoiceFile, wavDurationMs } from "./piper-local.ts";

let cached: TtsProvider | undefined;

function build(): TtsProvider {
  switch (env.TTS_PROVIDER) {
    case "piper-local":
    default:
      // Availability of the binary and the models is checked when synthesize()
      // runs, matching how whisper-local behaves.
      return new PiperTtsProvider({
        binary: env.PIPER_BINARY,
        voiceDir: env.PIPER_VOICE_DIR,
        defaultVoiceId: env.PIPER_VOICE || undefined,
      });
  }
}

/** The configured TTS provider. Constructed once, on first call. */
export function getTts(): TtsProvider {
  return (cached ??= build());
}

/** Test seam: drop the memoised provider. */
export function resetTts(): void {
  cached = undefined;
}

export { ProviderUnavailableError };
