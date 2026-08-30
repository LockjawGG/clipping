/**
 * Voiceover synchronisation.
 *
 * The hard part of voiceover is not synthesis, it is staying aligned after the
 * user edits. Storing one audio blob with an absolute start time breaks on the
 * first trim.
 *
 * So a voiceover is stored as *lines*, each anchored to the thing it was
 * generated from — a transcript segment, a caption cue. At playback and render
 * each line's position is resolved from its anchor's **current** timing, so
 * moving a clip moves its voiceover with it and nothing is re-synthesized. Only
 * a text change re-synthesizes, and only the affected lines.
 *
 * Pure. The placement maths is here; the ffmpeg mixing is in `ffmpeg/args.ts`.
 */

/** Where an anchor currently sits. Supplied fresh at every resolve. */
export interface AnchorTiming {
  ref: string;
  startMs: number;
  endMs: number;
}

/** One synthesized line, as stored. */
export interface VoiceLine {
  /** The anchor this line was generated from. */
  ref: string;
  text: string;
  /** Measured length of the synthesized audio, before any tempo change. */
  durationMs: number;
  /** Storage key / path of this line's audio. */
  audioKey: string;
}

export interface PlacedLine extends VoiceLine {
  startMs: number;
  /** Playback rate to make the line fit its window. 1 = untouched. */
  tempo: number;
  /** ms the line still overruns by after tempo was clamped. 0 when it fits. */
  overflowMs: number;
  /** Length after the tempo change. */
  playedMs: number;
}

export interface PlacementOptions {
  /**
   * How far a line may be sped up. ffmpeg's atempo accepts up to 100, but
   * speech stops being intelligible well before 1.5x and unpleasant before
   * that, so the default is deliberately conservative.
   */
  maxTempo?: number;
  /** Lines are never slowed down below this to fill a gap. 1 = never slow. */
  minTempo?: number;
  /** Extra room a line may use past its anchor before it counts as overrunning. */
  slackMs?: number;
  /** Hard end of the timeline; the last line may run to here. */
  durationMs?: number;
}

const DEFAULTS = {
  maxTempo: 1.35,
  minTempo: 1,
  slackMs: 250,
} as const;

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/**
 * Resolve stored lines against the current anchor timings.
 *
 * A line whose anchor has disappeared (the segment was deleted) is dropped
 * rather than guessed at — silently relocating narration is worse than losing
 * it, because the user cannot see that it moved.
 */
export function placeLines(
  lines: readonly VoiceLine[],
  anchors: readonly AnchorTiming[],
  options: PlacementOptions = {},
): PlacedLine[] {
  const maxTempo = Math.max(1, options.maxTempo ?? DEFAULTS.maxTempo);
  const minTempo = clamp(options.minTempo ?? DEFAULTS.minTempo, 0.5, 1);
  const slackMs = Math.max(0, options.slackMs ?? DEFAULTS.slackMs);

  const byRef = new Map(anchors.map((a) => [a.ref, a]));
  const live = lines
    .map((l) => ({ line: l, anchor: byRef.get(l.ref) }))
    .filter((x): x is { line: VoiceLine; anchor: AnchorTiming } => x.anchor !== undefined)
    .sort((a, b) => a.anchor.startMs - b.anchor.startMs);

  const out: PlacedLine[] = [];
  for (let i = 0; i < live.length; i++) {
    const { line, anchor } = live[i];
    const next = live[i + 1]?.anchor.startMs;
    // A line may run past its own anchor into the gap that follows, but never
    // into the next line — overlapping narration is unusable.
    const hardEnd = next ?? options.durationMs ?? anchor.endMs + slackMs;
    const window = Math.max(1, Math.min(hardEnd, anchor.endMs + slackMs) - anchor.startMs);

    let tempo = 1;
    if (line.durationMs > window) tempo = clamp(line.durationMs / window, minTempo, maxTempo);

    const playedMs = Math.round(line.durationMs / tempo);
    out.push({
      ...line,
      startMs: anchor.startMs,
      tempo: Math.round(tempo * 1000) / 1000,
      playedMs,
      overflowMs: Math.max(0, playedMs - window),
    });
  }
  return out;
}

/** Lines that could not be made to fit — the UI warns about these. */
export function overrunningLines(placed: readonly PlacedLine[]): PlacedLine[] {
  return placed.filter((p) => p.overflowMs > 0);
}

/** Refs whose text no longer matches what was synthesized. */
export function staleLines(
  lines: readonly VoiceLine[],
  currentText: ReadonlyMap<string, string>,
): VoiceLine[] {
  return lines.filter((l) => {
    const now = currentText.get(l.ref);
    return now !== undefined && normalize(now) !== normalize(l.text);
  });
}

/** Refs present in the source but with no line yet — what still needs synthesis. */
export function missingLines(
  lines: readonly VoiceLine[],
  currentText: ReadonlyMap<string, string>,
): string[] {
  const have = new Set(lines.map((l) => l.ref));
  return [...currentText.keys()].filter((ref) => !have.has(ref));
}

/** Whitespace and case are not worth re-synthesizing over. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface StoredVoiceover {
  version: 1;
  lines: VoiceLine[];
}

export function parseLines(json: string | null | undefined): VoiceLine[] {
  if (!json) return [];
  try {
    const p = JSON.parse(json) as Partial<StoredVoiceover> | VoiceLine[];
    const list = Array.isArray(p) ? p : p.version === 1 ? (p.lines ?? []) : [];
    return list.filter(
      (l): l is VoiceLine =>
        !!l &&
        typeof l === "object" &&
        typeof (l as VoiceLine).ref === "string" &&
        typeof (l as VoiceLine).text === "string" &&
        typeof (l as VoiceLine).audioKey === "string" &&
        Number.isFinite((l as VoiceLine).durationMs),
    );
  } catch {
    return [];
  }
}

export function serializeLines(lines: readonly VoiceLine[]): string | null {
  return lines.length ? JSON.stringify({ version: 1, lines }) : null;
}
