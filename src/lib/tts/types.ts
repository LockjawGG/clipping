/**
 * Text-to-speech provider boundary.
 *
 * Mirrors `TranscriptionProvider` deliberately: same shape, same availability
 * contract, same swap-one-factory-function property. The local default is a CLI
 * binary exactly as `whisper-local` is, so the operational story ("install this
 * binary, point an env var at it") is one the project already tells.
 */

export interface TtsVoice {
  /** Provider-specific id passed back to `synthesize`. */
  id: string;
  label: string;
  /** BCP-47-ish language tag, e.g. "en", "es", "pt-BR". */
  language: string;
  /** Present when the provider knows; used only for display. */
  gender?: "male" | "female" | "neutral";
}

export interface SynthesizeOptions {
  /** Provider voice id. Omitted uses the provider's default for `language`. */
  voiceId?: string;
  language?: string;
  /** 0.5..2. Applied by the provider when it can, otherwise by ffmpeg. */
  speed?: number;
  /** -1..1, provider-dependent. Ignored where unsupported. */
  pitch?: number;
  signal?: AbortSignal;
}

export interface SynthesisResult {
  /** Absolute path to the written WAV. */
  audioPath: string;
  durationMs: number;
  /** The written file's sample rate — audio spliced into it must match. */
  sampleRate: number;
  provider: string;
  voiceId: string;
}

export interface TtsProvider {
  readonly name: string;
  /** Voices this provider can offer. May hit the network or the filesystem. */
  voices(): Promise<TtsVoice[]>;
  /**
   * Synthesize `text` to `outputPath` as a WAV.
   * Throws `ProviderUnavailableError` when the binary or credentials are absent.
   */
  synthesize(text: string, outputPath: string, options?: SynthesizeOptions): Promise<SynthesisResult>;
}
