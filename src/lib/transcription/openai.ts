import { openAsBlob } from "node:fs";
import { basename } from "node:path";

import {
  ProviderUnavailableError,
  type Segment,
  type TranscribeOptions,
  type TranscriptionProvider,
  type TranscriptResult,
  type Word,
} from "../providers/types.ts";
import {
  attachWordsToSegments,
  clamp01,
  meanConfidence,
  normalizeLanguage,
  secToMs,
} from "./normalize.ts";

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/** Shape of `response_format=verbose_json` from the transcriptions endpoint. */
interface VerboseJson {
  language?: string;
  text?: string;
  words?: Array<{ word: string; start: number; end: number }>;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
  }>;
}

/** Pure: verbose_json → TranscriptResult. Exported for tests. */
export function parseVerboseJson(raw: VerboseJson, model: string): TranscriptResult {
  const words: Word[] = (raw.words ?? []).map((w) => {
    const startMs = secToMs(w.start);
    return { text: w.word.trim(), startMs, endMs: Math.max(startMs, secToMs(w.end)) };
  });

  const bare = (raw.segments ?? []).map((s) => {
    const startMs = secToMs(s.start);
    const confidence =
      typeof s.avg_logprob === "number" ? clamp01(Math.exp(s.avg_logprob)) : undefined;
    return {
      text: s.text.trim(),
      startMs,
      endMs: Math.max(startMs, secToMs(s.end)),
      ...(confidence !== undefined ? { confidence } : {}),
    };
  });

  const segments: Segment[] = attachWordsToSegments(bare, words);

  return {
    provider: "openai",
    model,
    language: normalizeLanguage(raw.language),
    confidence: meanConfidence(bare.map((s) => s.confidence)),
    segments,
  };
}

export interface OpenAiTranscriptionOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  readonly name = "openai";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;

  constructor(opts: OpenAiTranscriptionOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "whisper-1";
    this.endpoint = opts.baseUrl ? `${opts.baseUrl.replace(/\/+$/, "")}/audio/transcriptions` : ENDPOINT;
  }

  async transcribe(audioPath: string, options: TranscribeOptions = {}): Promise<TranscriptResult> {
    if (!this.apiKey) {
      throw new ProviderUnavailableError("transcription:openai", "OPENAI_API_KEY is not set");
    }

    const form = new FormData();
    form.set("file", await openAsBlob(audioPath), basename(audioPath));
    form.set("model", this.model);
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    if (options.language) form.set("language", options.language);

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: options.signal,
    });

    if (res.status === 401) {
      throw new ProviderUnavailableError("transcription:openai", "OPENAI_API_KEY was rejected (401)");
    }
    if (!res.ok) {
      throw new Error(`OpenAI transcription failed: ${res.status} ${await res.text()}`);
    }

    return parseVerboseJson((await res.json()) as VerboseJson, this.model);
  }
}
