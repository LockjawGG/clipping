import { readFile } from "node:fs/promises";

import {
  ProviderUnavailableError,
  type Segment,
  type TranscribeOptions,
  type TranscriptionProvider,
  type TranscriptResult,
  type Word,
} from "../providers/types.ts";
import { clamp01, groupWordsIntoSegments, meanConfidence, normalizeLanguage, secToMs } from "./normalize.ts";

const ENDPOINT = "https://api.deepgram.com/v1/listen";

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  punctuated_word?: string;
  speaker?: number;
}

interface DeepgramResponse {
  metadata?: { model_info?: Record<string, { name?: string }> };
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
        languages?: string[];
        words?: DeepgramWord[];
        paragraphs?: {
          paragraphs?: Array<{
            speaker?: number;
            sentences?: Array<{ text: string; start: number; end: number }>;
          }>;
        };
      }>;
    }>;
  };
}

/** Pure: Deepgram listen response → TranscriptResult. Exported for tests. */
export function parseDeepgramResponse(raw: DeepgramResponse, model: string): TranscriptResult {
  const alt = raw.results?.channels?.[0]?.alternatives?.[0] ?? {};
  const dgWords = alt.words ?? [];

  const words: Word[] = dgWords.map((w) => {
    const startMs = secToMs(w.start);
    return {
      text: (w.punctuated_word ?? w.word).trim(),
      startMs,
      endMs: Math.max(startMs, secToMs(w.end)),
      ...(typeof w.confidence === "number" ? { confidence: clamp01(w.confidence) } : {}),
    };
  });

  const wordSpeaker = (startMs: number, endMs: number): string | undefined => {
    const hit = dgWords.find((w) => secToMs(w.start) >= startMs - 1 && secToMs(w.end) <= endMs + 1);
    return typeof hit?.speaker === "number" ? `speaker_${hit.speaker}` : undefined;
  };

  let segments: Segment[];
  const paragraphs = alt.paragraphs?.paragraphs ?? [];
  if (paragraphs.length > 0) {
    segments = [];
    for (const p of paragraphs) {
      for (const s of p.sentences ?? []) {
        const startMs = secToMs(s.start);
        const endMs = Math.max(startMs, secToMs(s.end));
        const speaker =
          typeof p.speaker === "number" ? `speaker_${p.speaker}` : wordSpeaker(startMs, endMs);
        const segment: Segment = {
          text: s.text.trim(),
          startMs,
          endMs,
          words: words.filter((w) => w.startMs >= startMs - 1 && w.startMs < endMs + 1),
        };
        if (speaker) segment.speaker = speaker;
        segments.push(segment);
      }
    }
  } else {
    // No paragraph structure (diarize/punctuate off): fall back to word grouping.
    segments = groupWordsIntoSegments(words);
  }

  return {
    provider: "deepgram",
    model,
    language: normalizeLanguage(alt.languages?.[0]),
    confidence:
      typeof alt.confidence === "number"
        ? clamp01(alt.confidence)
        : meanConfidence(words.map((w) => w.confidence)),
    segments,
  };
}

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly name = "deepgram";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;

  constructor(opts: DeepgramOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "nova-2";
    this.endpoint = opts.baseUrl?.replace(/\/+$/, "") ?? ENDPOINT;
  }

  async transcribe(audioPath: string, options: TranscribeOptions = {}): Promise<TranscriptResult> {
    if (!this.apiKey) {
      throw new ProviderUnavailableError("transcription:deepgram", "DEEPGRAM_API_KEY is not set");
    }

    const params = new URLSearchParams({
      model: this.model,
      smart_format: "true",
      punctuate: "true",
      paragraphs: "true",
    });
    if (options.diarize) params.set("diarize", "true");
    if (options.language) params.set("language", options.language);
    if (options.vocabulary?.length) {
      for (const term of options.vocabulary) params.append("keyterm", term);
    }

    // The pipeline feeds this 16kHz mono PCM WAV (see buildExtractAudioArgs).
    const audio = await readFile(audioPath);
    const res = await fetch(`${this.endpoint}?${params}`, {
      method: "POST",
      headers: { authorization: `Token ${this.apiKey}`, "content-type": "audio/wav" },
      body: audio,
      signal: options.signal,
    });

    if (res.status === 401) {
      throw new ProviderUnavailableError("transcription:deepgram", "DEEPGRAM_API_KEY was rejected (401)");
    }
    if (!res.ok) {
      throw new Error(`Deepgram transcription failed: ${res.status} ${await res.text()}`);
    }

    return parseDeepgramResponse((await res.json()) as DeepgramResponse, this.model);
  }
}
