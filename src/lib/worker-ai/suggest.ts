/**
 * The worker's fusion step: transcript candidates + audio signals -> reviewable
 * suggestions.
 *
 * This module deliberately does not score transcripts itself. Clip candidates
 * come from the existing `AnalysisProvider` — heuristic, Anthropic or OpenAI,
 * whichever is configured — and this re-ranks and annotates them with what the
 * audio says. Rewriting the transcript scorer here would have produced two
 * rankings that drift apart.
 *
 * Everything is pure. Nothing here decides to change a project; it produces
 * proposals with their evidence attached, and a human accepts or rejects them.
 */

import type { AudioFeatures } from "../audio/features.ts";
import { findAudioMoments, findDeadAir, windowStats, type AudioMoment } from "../audio/energy.ts";
import type { ClipSuggestion } from "../providers/types.ts";
import { explainLengthFit, isUsable, lengthAffinity } from "../learning/apply.ts";
import type { StyleProfile } from "../learning/profile.ts";

export type SuggestionKind = "HIGHLIGHT" | "REACTION" | "DEAD_AIR";

/** The signals that fired for one suggestion, kept so the UI can show them. */
export interface SuggestionSignals {
  /** 0..1 loudness position within the recording. */
  energy?: number;
  /** Mean spectral flatness across the window. */
  flatness?: number;
  /** How much of the window is silence. */
  silenceRatio?: number;
  /** The transcript scorer's own confidence, when this came from one. */
  transcript?: number;
  /** ms of dead air removed, for DEAD_AIR. */
  savedMs?: number;
  /** 0..1 agreement with the learned clip length, when a profile applied. */
  lengthFit?: number;
}

export interface SuggestionDraft {
  kind: SuggestionKind;
  startMs: number;
  endMs: number;
  /** 0..1. */
  score: number;
  /** Plain-language evidence. Never empty — an unexplained suggestion is a
   *  black box, and the product's whole claim is that it is not one. */
  reason: string;
  signals: SuggestionSignals;
  /** Kind-specific extras: a highlight carries its title and hook. */
  payload?: Record<string, unknown>;
}

export interface WorkerObjectives {
  highlights?: boolean;
  reactions?: boolean;
  deadAir?: boolean;
}

export const DEFAULT_OBJECTIVES: Required<WorkerObjectives> = {
  highlights: true,
  reactions: true,
  deadAir: true,
};

export interface WorkerInput {
  /** Candidates from the configured AnalysisProvider, in absolute video ms. */
  candidates: readonly ClipSuggestion[];
  /** Null when the audio pass has not run (or the video has no audio). */
  features: AudioFeatures | null;
  objectives?: WorkerObjectives;
  /** Cap on highlight suggestions; reactions and dead air are not capped by it. */
  maxHighlights?: number;
  /** Dead air shorter than this is not worth a suggestion. */
  minDeadAirMs?: number;
  /** The learned style for this content type, when one exists and is trusted. */
  profile?: StyleProfile | null;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const secs = (ms: number) => (ms / 1000).toFixed(1);

/** Do two ranges overlap at all? */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * How much a candidate's score moves once the audio is taken into account.
 *
 * Weighted rather than replaced: the transcript decides *what was said*, which
 * is the stronger signal for a clip worth posting, and the audio decides *how
 * it was said*. A transcript-only ranking misses the moment everyone laughs;
 * an audio-only ranking loves every cough.
 */
const TRANSCRIPT_WEIGHT = 0.65;
const AUDIO_WEIGHT = 0.35;

/**
 * How much a usable profile shifts a highlight's score.
 *
 * Small on purpose. The profile knows what lengths this editor tends to cut,
 * which is a genuine preference — but it knows nothing about *this* recording,
 * so it nudges the ranking rather than driving it. A profile that could
 * outvote the content would turn "learned your style" into "ignores the
 * material".
 */
const PROFILE_WEIGHT = 0.2;

function highlightSuggestions(input: WorkerInput, moments: AudioMoment[]): SuggestionDraft[] {
  const { candidates, features } = input;
  const max = input.maxHighlights ?? 8;
  const profile = isUsable(input.profile) ? input.profile : null;

  const drafts = candidates.map((c) => {
    const signals: SuggestionSignals = { transcript: clamp01(c.score) };
    const why: string[] = [];

    let audioScore = 0.5; // neutral when there is no audio to consult
    if (features && features.loudness.length > 0) {
      const w = windowStats(features, c.startMs, c.endMs);
      signals.energy = w.energy;
      signals.flatness = w.flatness;
      signals.silenceRatio = w.silenceRatio;
      audioScore = w.energy;

      if (w.energy >= 0.75) why.push(`energy in the top quarter of this recording`);
      else if (w.energy <= 0.25) why.push(`quieter than most of this recording`);

      // A window that is mostly silence is a bad clip however well it reads.
      if (w.silenceRatio > 0.3) {
        audioScore *= 1 - w.silenceRatio;
        why.push(`${Math.round(w.silenceRatio * 100)}% silence`);
      }

      const laugh = moments.find(
        (m) => m.kind === "laughter" && overlaps(m.startMs, m.endMs, c.startMs, c.endMs),
      );
      if (laugh) {
        audioScore = clamp01(audioScore + 0.2);
        why.push("a laugh or crowd reaction lands inside it");
      }
    }

    let score = clamp01(TRANSCRIPT_WEIGHT * clamp01(c.score) + AUDIO_WEIGHT * audioScore);

    // The learned profile contributes a nudge and a sentence. The sentence is
    // the point: it is what turns "the model liked this" into something the
    // user can check against their own habits.
    if (profile) {
      const affinity = lengthAffinity(profile, c.startMs, c.endMs);
      score = clamp01(score * (1 - PROFILE_WEIGHT) + affinity * PROFILE_WEIGHT);
      signals.lengthFit = affinity;
      const fit = explainLengthFit(profile, c.startMs, c.endMs);
      if (fit) why.push(fit);
    }

    // The transcript scorer already explains itself; the audio adds to that.
    const reason = [c.reason?.trim(), ...why].filter(Boolean).join(" · ") || "matched the clip scorer";

    return {
      kind: "HIGHLIGHT" as const,
      startMs: c.startMs,
      endMs: c.endMs,
      score,
      reason,
      signals,
      payload: {
        title: c.title,
        hook: c.hook,
        caption: c.caption,
        socialTitle: c.socialTitle,
        hashtags: c.hashtags,
      },
    };
  });

  return drafts.sort((a, b) => b.score - a.score).slice(0, max);
}

function reactionSuggestions(moments: AudioMoment[], taken: SuggestionDraft[]): SuggestionDraft[] {
  return moments
    .filter((m) => m.kind === "laughter")
    // A reaction already inside a proposed highlight is not a separate finding.
    .filter((m) => !taken.some((h) => overlaps(m.startMs, m.endMs, h.startMs, h.endMs)))
    .map((m) => ({
      kind: "REACTION" as const,
      startMs: m.startMs,
      endMs: m.endMs,
      score: m.score,
      reason: m.reason,
      signals: { flatness: m.score },
    }));
}

function deadAirSuggestions(features: AudioFeatures, minMs: number): SuggestionDraft[] {
  return findDeadAir(features, minMs).map((d) => ({
    kind: "DEAD_AIR" as const,
    startMs: d.startMs,
    endMs: d.endMs,
    score: clamp01(d.durationMs / 5000),
    reason: `${secs(d.durationMs)}s of silence`,
    signals: { savedMs: d.durationMs, silenceRatio: 1 },
  }));
}

/**
 * Build the full suggestion set for one worker run.
 *
 * Ordering is by time, not score: the review panel is read against the
 * recording, and jumping around it to triage would be worse than seeing the
 * run in order. Each kind carries its own score for sorting within the UI.
 */
export function buildSuggestions(input: WorkerInput): SuggestionDraft[] {
  const objectives = { ...DEFAULT_OBJECTIVES, ...(input.objectives ?? {}) };
  const features = input.features;
  const moments = features ? findAudioMoments(features) : [];

  const out: SuggestionDraft[] = [];
  const highlights = objectives.highlights ? highlightSuggestions(input, moments) : [];
  out.push(...highlights);

  if (objectives.reactions && features) {
    out.push(...reactionSuggestions(moments, highlights));
  }
  if (objectives.deadAir && features) {
    out.push(...deadAirSuggestions(features, input.minDeadAirMs ?? 800));
  }

  return out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
