/**
 * Provider boundary.
 *
 * Everything above this line in the app talks to these interfaces only. Swapping
 * Whisper for Deepgram, or S3 for R2, should touch exactly one factory function
 * and no call sites.
 *
 * All times are integer milliseconds.
 */

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface Segment {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string;
  confidence?: number;
  words: Word[];
}

export interface TranscriptResult {
  provider: string;
  model?: string;
  language: string;
  confidence?: number;
  segments: Segment[];
}

export interface TranscribeOptions {
  language?: string;
  wordTimestamps?: boolean;
  diarize?: boolean;
  /** Proper nouns the model routinely mangles. */
  vocabulary?: string[];
  signal?: AbortSignal;
  /** Total audio length, so a provider can report progress as a fraction. */
  durationMs?: number;
  /** Called with 0..1 as transcription advances, when the provider can tell. */
  onProgress?: (fraction: number) => void;
  /** Called on any sign of life from the provider — used to keep the job lease alive. */
  onActivity?: () => void;
}

export interface TranscriptionProvider {
  readonly name: string;
  /** Throws ProviderUnavailableError when credentials are absent. */
  transcribe(audioPath: string, options?: TranscribeOptions): Promise<TranscriptResult>;
}

export interface StorageProvider {
  readonly name: string;
  /** Presigned PUT for direct browser upload; the server never proxies bytes. */
  createUploadUrl(key: string, contentType: string, expiresInSec?: number): Promise<string>;
  createDownloadUrl(key: string, expiresInSec?: number): Promise<string>;
  putFile(key: string, localPath: string, contentType: string): Promise<void>;
  getToFile(key: string, localPath: string): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export interface ClipSuggestion {
  startMs: number;
  endMs: number;
  title: string;
  hook: string;
  description: string;
  reason: string;
  caption: string;
  socialTitle: string;
  hashtags: string[];
  score: number;
}

export interface AnalyzeOptions {
  minClipMs: number;
  maxClipMs: number;
  maxClips: number;
  style?: string;
  signal?: AbortSignal;
}

export interface AnalysisProvider {
  readonly name: string;
  suggestClips(segments: Segment[], options: AnalyzeOptions): Promise<ClipSuggestion[]>;
}

/**
 * Thrown when a provider is configured but unusable (missing key, no binary).
 * The API layer maps this to a 503 with an actionable message rather than a
 * generic 500, so the UI can say which env var is missing.
 */
export class ProviderUnavailableError extends Error {
  readonly provider: string;
  readonly hint: string;

  constructor(provider: string, hint: string) {
    super(`Provider "${provider}" is unavailable: ${hint}`);
    // Parameter properties are deliberately avoided: `node --experimental-strip-types`
    // runs the test suites in strip-only mode and cannot transform them.
    this.name = "ProviderUnavailableError";
    this.provider = provider;
    this.hint = hint;
  }
}
