import type {
  AnalysisProvider,
  AnalyzeOptions,
  ClipSuggestion,
  Segment,
} from "../providers/types.ts";
import { clamp01 } from "../transcription/normalize.ts";

/**
 * A no-LLM baseline so the app runs end to end with zero API keys. It slides a
 * window over the transcript, scores each candidate on shallow signals, and
 * returns the raw suggestions. Boundary snapping and dedupe happen in
 * `refineSuggestions`, same as for the model-backed providers.
 */

const HOOK_WORDS =
  /\b(secret|mistake|never|always|nobody|everyone|truth|why|how|reason|crazy|insane|shocked|realized|honestly|the thing is)\b/i;
const NUMERIC = /\b\d+([.,]\d+)?\s?(%|percent|x|times|million|billion|thousand|dollars|years?)\b/i;

function scoreWindow(segs: Segment[]): number {
  const text = segs.map((s) => s.text).join(" ");
  const durationS = (segs[segs.length - 1].endMs - segs[0].startMs) / 1000;

  let score = 0.3;
  if (/[?]/.test(segs[0].text)) score += 0.15; // opens on a question
  if (HOOK_WORDS.test(text)) score += 0.2;
  if (NUMERIC.test(text)) score += 0.1;
  if (/[.!?]$/.test(text.trim())) score += 0.1; // ends on a complete sentence
  // Prefer ~30s; fall off toward the edges of the allowed range.
  score += 0.15 * (1 - Math.min(1, Math.abs(durationS - 30) / 30));
  // Transcription confidence, if the provider gave it.
  const confs = segs.map((s) => s.confidence).filter((c): c is number => typeof c === "number");
  if (confs.length) score += 0.1 * (confs.reduce((a, b) => a + b, 0) / confs.length - 0.5);

  return clamp01(score);
}

export class HeuristicAnalysisProvider implements AnalysisProvider {
  readonly name = "heuristic";

  async suggestClips(segments: Segment[], options: AnalyzeOptions): Promise<ClipSuggestion[]> {
    if (segments.length === 0) return [];

    const candidates: ClipSuggestion[] = [];
    for (let start = 0; start < segments.length; start++) {
      for (let end = start; end < segments.length; end++) {
        const window = segments.slice(start, end + 1);
        const duration = window[window.length - 1].endMs - window[0].startMs;
        if (duration < options.minClipMs) continue;
        if (duration > options.maxClipMs) break;

        const text = window.map((s) => s.text).join(" ").trim();
        const score = scoreWindow(window);
        candidates.push({
          startMs: window[0].startMs,
          endMs: window[window.length - 1].endMs,
          title: text.split(/[.!?]/)[0].slice(0, 80).trim() || "Untitled clip",
          hook: window[0].text.trim(),
          description: text.slice(0, 200).trim(),
          reason: "Selected by the heuristic scorer (no language model configured).",
          caption: text.slice(0, 140).trim(),
          socialTitle: text.split(/[.!?]/)[0].slice(0, 60).trim() || "Untitled clip",
          hashtags: [],
          score,
        });
      }
    }

    // Hand back the best few raw; refineSuggestions does the real selection.
    return candidates.sort((a, b) => b.score - a.score).slice(0, Math.max(options.maxClips * 4, 12));
  }
}
