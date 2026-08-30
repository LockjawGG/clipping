"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CAPTION_CENSOR_MODES, type CaptionCensorMode, maskWord } from "@/lib/censor/mask.ts";
import type {
  AudioCensorMode,
  CensorWordOverride,
  CensorWordOverrides,
} from "@/lib/censor/overrides.ts";

/** The audio treatments, with the label each is known by in the UI. */
const AUDIO_MODE_LABELS: { id: AudioCensorMode; label: string }[] = [
  { id: "BEEP", label: "Beep (1 kHz)" },
  { id: "TONE", label: "Soft tone (400 Hz)" },
  { id: "MUTE", label: "Silence" },
];

/** Beep is the red one, matching the strike; the softer tone and plain silence
 *  step down from it so the marker says which sound without a legend. */
const soundName = (mode: AudioCensorMode | undefined) =>
  mode === "MUTE" ? "silenced" : mode === "TONE" ? "replaced with a 400 Hz tone" : "beeped";

/** Short forms for the multi-word summary, where the full sentence would not
 *  fit: "2 beeped, 1 silenced". */
const SOUND_SHORT: Record<AudioCensorMode, string> = {
  BEEP: "beeped",
  TONE: "as a 400 Hz tone",
  MUTE: "silenced",
};

const AUDIO_MODE_COLOR: Record<AudioCensorMode, string> = {
  BEEP: "rgb(var(--c-danger))",
  TONE: "#d97706",
  MUTE: "rgb(var(--c-muted))",
};


export interface TranscriptWord {
  id: string;
  text: string;
  /** Absolute ms in the source video. */
  startMs: number;
  endMs: number;
}
export interface TranscriptRow {
  startMs: number;
  endMs: number;
  speaker: string | null;
  /** Row text — joined words for the source, the segment string for a translation. */
  text: string;
  words: TranscriptWord[];
}

/**
 * The lookup key a word contributes to the clip's allow / deny lists.
 *
 * Those lists are keyed by term, not by occurrence, because that is what the
 * renderer matches on -- so ticking one "damn" ticks every "damn" in the clip,
 * and the transcript visibly updates all of them at once.
 */
export const censorKey = (text: string) => text.toLowerCase().replace(/[^\p{L}']/gu, "");

/** Per-word caption style override. `null` = attribute not set. */
export interface WordStyle {
  color: string | null;
  bold: boolean | null;
  italic: boolean | null;
  sizeScale: number | null;
}
export type WordStylePatch = Partial<WordStyle>;

const timecode = (ms: number) => {
  const t = Math.round(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

const SWATCHES = ["#FFFFFF", "#FFE600", "#00E5FF", "#FF4D4D", "#7CFF6B", "#FF7AF0"];

/** CSS for a word span from its style override. */
export function wordSpanCss(s: WordStyle | undefined): React.CSSProperties {
  if (!s) return {};
  return {
    color: s.color ?? undefined,
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? "italic" : undefined,
    fontSize: s.sizeScale ? `${s.sizeScale}em` : undefined,
  };
}

/**
 * One transcript word: single-click seeks the preview to it (and selects it for
 * caption styling); double-click edits its text.
 */
const Word = memo(function Word({
  censored,
  bleeped,
  audioMode,
  outsideClip,
  cut,
  word,
  style,
  selected,
  matched,
  active,
  onToggleSelect,
  onSeek,
}: {
  /** This word is struck out: the render cuts it and closes the clip up. */
  cut?: boolean;
  /** This word will be masked in the captions. */
  censored?: boolean;
  /** This word will be bleeped in the audio. Independent of the mask. */
  bleeped?: boolean;
  /** Which sound replaces it, once bleeped. Colours the marker. */
  audioMode?: AudioCensorMode;
  /** Falls outside the clip's range, so it never reaches the output. */
  outsideClip?: boolean;
  word: TranscriptWord;
  style: WordStyle | undefined;
  selected: boolean;
  matched: boolean;
  active: boolean;
  onToggleSelect: (id: string) => void;
  onSeek: (absStartMs: number) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(word.text);
  const [busy, setBusy] = useState(false);

  async function save() {
    setEditing(false);
    const next = value.trim();
    if (!next || next === word.text) {
      setValue(word.text);
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/transcript/words/${word.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: next }),
    });
    setBusy(false);
    if (res.ok) router.refresh();
    else setValue(word.text);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setValue(word.text);
            setEditing(false);
          }
        }}
        size={Math.max(value.length, 2)}
        className="mx-0.5 rounded border border-accent/60 bg-surface-raised px-1 py-0 text-sm outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      id={`tw-${word.id}`}
      onClick={() => {
        onSeek(word.startMs);
        onToggleSelect(word.id);
      }}
      onDoubleClick={() => setEditing(true)}
      aria-pressed={selected}
      style={
        bleeped && !cut
          ? {
              ...wordSpanCss(style),
              borderBottom: `2px dotted ${AUDIO_MODE_COLOR[audioMode ?? "BEEP"]}`,
            }
          : wordSpanCss(style)
      }
      className={`rounded px-0.5 ${busy ? "opacity-50" : ""} ${
        outsideClip ? "opacity-40" : ""
      } ${
        selected
          ? "bg-accent/30 ring-1 ring-accent"
          : active
            ? "bg-amber-400/60 ring-1 ring-amber-500"
            : matched
              ? "bg-amber-400/25"
              : "hover:bg-accent/15"
      } ${
        // A cut word is not in the export at all, so it outranks the censor
        // marks: bleeping or masking something that was removed says nothing
        // true about the render. Faded and struck in the muted colour, which is
        // how deleted text reads everywhere; the censor strike is red.
        cut
          ? "opacity-45 line-through decoration-2 decoration-muted"
          : // The strike means masked in the captions. The bleep marker below is
            // a border rather than an underline because the two must be able to
            // show at once in different colours, and text-decoration-color is a
            // single value shared by every line on the element.
            censored
            ? "line-through decoration-2 decoration-danger"
            : ""
      }`}
      title={
        outsideClip
          ? "Outside this clip - it will not appear in the render"
          : cut
            ? "Cut out - the clip closes up over this word. Click Restore to put it back."
            : censored && bleeped
            ? `Masked in the captions and ${soundName(audioMode)} in the audio`
            : censored
              ? "Masked in the captions, but left audible"
              : bleeped
                ? `${soundName(audioMode)} in the audio, but not masked in the captions`
                : "Click to jump the preview here · double-click to fix a typo"
      }
    >
      {value}
    </button>
  );
});

interface Props {
  rows: TranscriptRow[];
  styles: Record<string, WordStyle>;
  selectedIds: Set<string>;
  onToggleSelect: (wordId: string) => void;
  onApplyStyle: (patch: WordStylePatch) => void;
  onReset: () => void;
  onClearSelection: () => void;
  /** Jump the preview to a word (absolute ms in the source video). */
  onSeek: (absStartMs: number) => void;
  /** Make a clip spanning the currently-selected words (absolute ms). */
  onClipFromSelection?: (startMs: number, endMs: number) => void;
  /** Word ids the render will mask — drives both the tick and the strike. */
  censoredIds?: ReadonlySet<string>;
  /**
   * Word ids struck out of the middle of the clip. These are cut from the
   * render and the clip closes up over them, which is why they read as deleted
   * rather than censored: the word is not in the export at all.
   */
  cutIds?: ReadonlySet<string>;
  /** Strike these words out, or put them back. */
  onSetCut?: (wordIds: string[], cut: boolean) => void;
  /**
   * The clip's own range. Rows are selected by segment overlap, so the edges of
   * the transcript show words that fall outside the clip and will never reach
   * the render — those must not look censorable.
   */
  clipStartMs?: number;
  clipEndMs?: number;
  /**
   * Turn censoring on or off for these specific occurrences on this clip only.
   * Takes transcript word ids, so "censor this damn but not that one" works;
   * the override is per-clip and never edits the shared lexicon.
   */
  onSetCensored?: (wordIds: string[], censored: boolean) => void;
  /**
   * Whether the censored words are bleeped in the audio. Independent of which
   * words are censored: with this off the caption text is still masked, the
   * speech is just left audible.
   */
  audioCensored?: boolean;
  onSetAudioCensored?: (on: boolean) => void;
  /** Of the censored words, the ones that will actually be bleeped. */
  bleepedIds?: ReadonlySet<string>;
  /** Turn the bleep on or off for these occurrences, on this clip only. */
  onSetBleeped?: (wordIds: string[], bleeped: boolean) => void;
  /** Per-occurrence censor settings, keyed by word id. */
  wordOverrides?: CensorWordOverrides;
  /** The clip's own settings, shown as the "follow clip" fallback. */
  clipAudioMode?: AudioCensorMode;
  clipCaptionMode?: CaptionCensorMode;
  clipReplacement?: string | null;
  /** Set or clear a per-word setting. A null value means "follow the clip". */
  onSetWordCensorOptions?: (
    wordIds: string[],
    patch: Partial<Record<keyof CensorWordOverride, unknown>>,
  ) => void;
}

/**
 * The clip transcript, doubling as a caption-styling surface. Words are the
 * source text (double-click to correct) AND selectable spans that can be given
 * a colour / bold / italic / size that overrides the clip's base caption style.
 * Memoised so caption-slider and playhead changes upstream don't re-render it.
 */
export const EditableTranscript = memo(function EditableTranscript({
  rows,
  styles,
  selectedIds,
  onToggleSelect,
  onApplyStyle,
  onReset,
  onClearSelection,
  onSeek,
  onClipFromSelection,
  censoredIds,
  cutIds,
  onSetCut,
  clipStartMs,
  clipEndMs,
  onSetCensored,
  audioCensored,
  onSetAudioCensored,
  bleepedIds,
  onSetBleeped,
  wordOverrides,
  clipAudioMode,
  clipCaptionMode,
  clipReplacement,
  onSetWordCensorOptions,
}: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  // Matching word ids, in reading order, plus a fast lookup set.
  const matches = useMemo(() => {
    if (q.length === 0) return { ids: [] as string[], set: new Set<string>() };
    const ids: string[] = [];
    for (const row of rows) {
      if (row.words.length === 0) {
        if (row.text.toLowerCase().includes(q)) ids.push(`row-${row.startMs}`);
        continue;
      }
      for (const w of row.words) {
        if (w.text.toLowerCase().includes(q)) ids.push(w.id);
      }
    }
    return { ids, set: new Set(ids) };
  }, [rows, q]);

  /** Words the render will actually see. Anything outside the clip is visible
   *  for context but cannot be censored, because it is not in the output. */
  const inClip = useCallback(
    (w: TranscriptWord) =>
      clipStartMs === undefined || clipEndMs === undefined
        ? true
        : w.startMs >= clipStartMs && w.endMs <= clipEndMs,
    [clipStartMs, clipEndMs],
  );

  /**
   * The selected occurrences, split by whether each is currently censored, so
   * the toolbar can offer both directions rather than only the one. Keyed by
   * word id, not by term — the whole point is that two identical words can
   * carry different decisions.
   */
  const selectedByCensored = useMemo(() => {
    const on: string[] = [];
    const off: string[] = [];
    for (const row of rows)
      for (const w of row.words) {
        if (!selectedIds.has(w.id) || !censorKey(w.text) || !inClip(w)) continue;
        (censoredIds?.has(w.id) ? on : off).push(w.id);
      }
    return { censored: on, clean: off };
  }, [rows, selectedIds, censoredIds, inClip]);

  /**
   * The selected words split by whether they are already cut. No word-shape
   * filter here, unlike censoring: any word can be struck out, including the
   * "um" that is not in anyone's lexicon.
   */
  const selectedByCut = useMemo(() => {
    const on: string[] = [];
    const off: string[] = [];
    for (const row of rows)
      for (const w of row.words) {
        if (!selectedIds.has(w.id) || !inClip(w)) continue;
        (cutIds?.has(w.id) ? on : off).push(w.id);
      }
    return { cut: on, kept: off };
  }, [rows, selectedIds, cutIds, inClip]);

  /** How many of the selected words the render can actually censor. The plain
   *  selection count would overstate it whenever the selection reaches past the
   *  clip's edges. */
  const censorableCount =
    selectedByCensored.censored.length + selectedByCensored.clean.length;

  /**
   * The selected occurrences, split by whether each is bleeped. Every
   * censorable word appears, not just the masked ones: silencing a word and
   * masking its caption are separate choices, so the bleep has to be offered
   * on its own.
   */
  const selectedByBleeped = useMemo(() => {
    const on: string[] = [];
    const off: string[] = [];
    for (const row of rows) {
      for (const w of row.words) {
        if (!selectedIds.has(w.id) || !censorKey(w.text) || !inClip(w)) continue;
        (bleepedIds?.has(w.id) ? on : off).push(w.id);
      }
    }
    return { bleeped: on, silent: off };
  }, [rows, selectedIds, bleepedIds, inClip]);

  /** true = all bleeped, false = none, null = mixed. */
  const allBleeped =
    selectedByBleeped.bleeped.length > 0 && selectedByBleeped.silent.length > 0
      ? null
      : selectedByBleeped.bleeped.length > 0;

  /** The censorable words in the selection — what the settings row acts on. */
  const selectedCensorable = useMemo(
    () => [...selectedByCensored.censored, ...selectedByCensored.clean],
    [selectedByCensored],
  );

  /**
   * A setting's value across the selection, or undefined when they disagree.
   *
   * Disagreement shows as "follow clip" rather than picking a winner: the
   * select is an instruction, and pre-filling it with one word's value would
   * quietly apply that value to the rest on the next unrelated change.
   */
  const sharedOverride = useCallback(
    <K extends keyof CensorWordOverride>(key: K): CensorWordOverride[K] | undefined => {
      if (selectedCensorable.length === 0) return undefined;
      const first = wordOverrides?.[selectedCensorable[0]]?.[key];
      return selectedCensorable.every((id) => wordOverrides?.[id]?.[key] === first)
        ? first
        : undefined;
    },
    [selectedCensorable, wordOverrides],
  );

  const selectedAudioMode = sharedOverride("audioMode");
  const selectedCaptionMode = sharedOverride("captionMode");
  const selectedReplacement = sharedOverride("replacement");

  /** One sentence describing what the render will do with the selection. */
  const censorPreview = useMemo(() => {
    const n = selectedCensorable.length;
    if (n === 0) return "";
    const masked = selectedByCensored.censored.length;
    const bleeped = selectedByBleeped.bleeped.length;
    if (masked === 0 && bleeped === 0) {
      return n === 1 ? "Not censored." : "None of these are censored.";
    }

    const audioMode = selectedAudioMode ?? clipAudioMode ?? "BEEP";
    const sound =
      audioMode === "MUTE"
        ? "goes silent"
        : audioMode === "TONE"
          ? "sounds as a 400 Hz tone"
          : "sounds as a 1 kHz beep";

    // For a single word the mask can be shown literally, which is far clearer
    // than naming the mode.
    if (n === 1) {
      const id = selectedCensorable[0];
      const word = rows.flatMap((r) => r.words).find((w) => w.id === id);
      const readsAs =
        masked > 0 && word
          ? `reads as ${maskWord(
              word.text,
              selectedCaptionMode ?? clipCaptionMode ?? "FULL",
              selectedReplacement ?? clipReplacement ?? undefined,
            )}`
          : "is not masked";
      return `"${word?.text ?? ""}" ${readsAs} and ${bleeped > 0 ? sound : "stays audible"}.`;
    }
    // Naming one sound for a mixed selection would state something the render
    // will not do, so the sounds actually in play are counted instead.
    const counts = new Map<AudioCensorMode, number>();
    for (const id of selectedByBleeped.bleeped) {
      const mode = wordOverrides?.[id]?.audioMode ?? clipAudioMode ?? "BEEP";
      counts.set(mode, (counts.get(mode) ?? 0) + 1);
    }
    const breakdown = [...counts.entries()]
      .map(([mode, count]) => `${count} ${SOUND_SHORT[mode]}`)
      .join(", ");

    return (
      `${masked} of ${n} masked in the captions, ` +
      `${bleeped} bleeped${bleeped > 0 ? ` — ${breakdown}` : ""}.`
    );
  }, [
    rows,
    selectedCensorable,
    selectedByCensored,
    selectedByBleeped,
    wordOverrides,
    selectedAudioMode,
    selectedCaptionMode,
    selectedReplacement,
    clipAudioMode,
    clipCaptionMode,
    clipReplacement,
  ]);

  /**
   * How many in-clip words the render will mask.  /**
   * How many in-clip words the render will mask. Drives the audio toggle: a
   * switch for bleeping nothing would be a control with no effect, so it only
   * appears once there is something to bleep.
   */
  const censoredCount = useMemo(() => {
    if (!censoredIds || censoredIds.size === 0) return 0;
    let n = 0;
    for (const row of rows) {
      for (const w of row.words) if (censoredIds.has(w.id) && inClip(w)) n++;
    }
    return n;
  }, [rows, censoredIds, inClip]);

  /** Of those, how many are actually bleeped. */
  const bleepedCount = useMemo(() => {
    if (!bleepedIds || bleepedIds.size === 0) return 0;
    let n = 0;
    for (const row of rows) {
      for (const w of row.words) if (bleepedIds.has(w.id) && inClip(w)) n++;
    }
    return n;
  }, [rows, bleepedIds, inClip]);

  /** true = all selected words censored, false = none, null = mixed. */
  const allCensored =
    selectedByCensored.censored.length > 0 && selectedByCensored.clean.length > 0
      ? null
      : selectedByCensored.censored.length > 0;

  const selectedSpan = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of rows)
      for (const w of row.words)
        if (selectedIds.has(w.id)) {
          lo = Math.min(lo, w.startMs);
          hi = Math.max(hi, w.endMs);
        }
    return lo <= hi ? { startMs: lo, endMs: hi } : null;
  }, [rows, selectedIds]);

  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => setActiveIdx(0), [q]);
  const activeId = matches.ids[activeIdx] ?? null;

  const step = (delta: number) => {
    if (matches.ids.length === 0) return;
    setActiveIdx((i) => {
      const next = (i + delta + matches.ids.length) % matches.ids.length;
      const id = matches.ids[next];
      document.getElementById(`tw-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      const w = rows.flatMap((r) => r.words).find((x) => x.id === id);
      if (w) onSeek(w.startMs);
      return next;
    });
  };

  if (rows.length === 0) {
    return <p className="text-xs text-muted">No transcript for this range.</p>;
  }
  const count = selectedIds.size;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-xs">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          }}
          placeholder="Search the transcript…"
          className="field h-7 min-w-0 flex-1 py-0 text-xs"
        />
        {onSetAudioCensored && (censoredCount > 0 || bleepedCount > 0) && (
          <button
            type="button"
            onClick={() => onSetAudioCensored(!audioCensored)}
            aria-pressed={audioCensored ?? false}
            title={
              `${bleepedCount} word${bleepedCount === 1 ? " is" : "s are"} bleeped in the audio; ` +
              `${censoredCount} masked in the captions. ` +
              `Click to ${audioCensored ? "stop bleeping censored words by default" : "bleep censored words by default"} — ` +
              "individual words can still be ticked either way."
            }
            className={`pill shrink-0 ${bleepedCount > 0 ? "border-danger/50 text-danger" : "text-muted"}`}
          >
            {/* The count, not just the switch: with per-word overrides in play
                a plain on/off label would misstate what the render does. */}
            {bleepedCount === 0
              ? "🔊 audio uncensored"
              : `🔇 ${bleepedCount} bleeped`}
          </button>
        )}
        {q.length > 0 && (
          <>
            <span className="shrink-0 tabular-nums text-muted">
              {matches.ids.length === 0
                ? "no matches"
                : `${activeIdx + 1} / ${matches.ids.length}`}
            </span>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={matches.ids.length === 0}
              className="btn btn-ghost btn-sm"
              aria-label="Previous match"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={matches.ids.length === 0}
              className="btn btn-ghost btn-sm"
              aria-label="Next match"
            >
              ↓
            </button>
          </>
        )}
      </div>
      {count > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 text-xs">
          <span className="font-medium text-muted">
            {count} word{count > 1 ? "s" : ""}
          </span>
          <span className="flex items-center gap-1">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                onClick={() => onApplyStyle({ color: c })}
                style={{ background: c }}
                className="h-5 w-5 rounded border border-border"
              />
            ))}
            <input
              type="color"
              aria-label="Custom colour"
              onChange={(e) => onApplyStyle({ color: e.target.value.toUpperCase() })}
              className="h-5 w-6 rounded border border-border bg-surface"
            />
          </span>
          <button type="button" onClick={() => onApplyStyle({ bold: true })} className="btn btn-ghost btn-sm font-bold">
            B
          </button>
          <button type="button" onClick={() => onApplyStyle({ italic: true })} className="btn btn-ghost btn-sm italic">
            I
          </button>
          <button
            type="button"
            title="Smaller"
            onClick={() => onApplyStyle({ sizeScale: 0.85 })}
            className="btn btn-ghost btn-sm"
          >
            A−
          </button>
          <button
            type="button"
            title="Bigger"
            onClick={() => onApplyStyle({ sizeScale: 1.4 })}
            className="btn btn-ghost btn-sm"
          >
            A+
          </button>
          <button type="button" onClick={onReset} className="btn btn-ghost btn-sm text-muted hover:text-danger">
            Reset
          </button>
          {onSetCut && selectedByCut.kept.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-muted hover:text-danger"
              title="Cut these words out. The clip closes up over them and gets shorter."
              onClick={() => onSetCut(selectedByCut.kept, true)}
            >
              Cut out
            </button>
          )}
          {onSetCut && selectedByCut.cut.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="Put these words back into the clip"
              onClick={() => onSetCut(selectedByCut.cut, false)}
            >
              Restore
            </button>
          )}
          {onClipFromSelection && selectedSpan && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="Create a clip spanning these words"
              onClick={() => onClipFromSelection(selectedSpan.startMs, selectedSpan.endMs)}
            >
              Clip from selection
            </button>
          )}
          <button type="button" onClick={onClearSelection} className="btn btn-ghost btn-sm ml-auto">
            Done
          </button>
        </div>
      )}

      {/* Censoring gets its own row rather than competing for space with the
          caption styling above it: these are four related controls that have to
          read as one decision about the selected words, and the preview line
          under them is what makes the combination legible before rendering. */}
      {count > 0 && onSetCensored && censorableCount > 0 && (
        <div className="flex flex-col gap-1 border-b border-border bg-surface px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-medium uppercase tracking-wide text-danger">Censor</span>

            <label
              className="flex items-center gap-1.5"
              title="Mask these words in the captions. The shared word list is unchanged."
            >
              <input
                type="checkbox"
                ref={(el) => {
                  if (el) el.indeterminate = allCensored === null;
                }}
                checked={allCensored === true}
                onChange={(e) => {
                  const on = e.target.checked;
                  const ids = on ? selectedByCensored.clean : selectedByCensored.censored;
                  if (ids.length > 0) onSetCensored(ids, on);
                }}
                className="h-3 w-3 cursor-pointer accent-[rgb(var(--c-danger))]"
              />
              captions
            </label>

            {onSetBleeped && (
              <label
                className="flex items-center gap-1.5"
                title="Silence these words in the audio. Independent of the caption mask."
              >
                <input
                  type="checkbox"
                  ref={(el) => {
                    if (el) el.indeterminate = allBleeped === null;
                  }}
                  checked={allBleeped === true}
                  onChange={(e) => {
                    const on = e.target.checked;
                    const ids = on ? selectedByBleeped.silent : selectedByBleeped.bleeped;
                    if (ids.length > 0) onSetBleeped(ids, on);
                  }}
                  className="h-3 w-3 cursor-pointer accent-[rgb(var(--c-danger))]"
                />
                audio
              </label>
            )}

            {onSetWordCensorOptions && (
              <>
                <label className="flex items-center gap-1.5" title="How these words are silenced.">
                  sound
                  <select
                    value={selectedAudioMode ?? ""}
                    onChange={(e) =>
                      onSetWordCensorOptions(selectedCensorable, {
                        audioMode: e.target.value || null,
                      })
                    }
                    className="field py-0.5"
                  >
                    {/* "Follow clip" is a real value, not a placeholder: it is
                        how a word goes back to tracking the clip setting. */}
                    <option value="">
                      follow clip
                      {clipAudioMode
                        ? ` (${AUDIO_MODE_LABELS.find((m) => m.id === clipAudioMode)?.label})`
                        : ""}
                    </option>
                    {AUDIO_MODE_LABELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5" title="How these words are written on screen.">
                  mask
                  <select
                    value={selectedCaptionMode ?? ""}
                    onChange={(e) => {
                      const next = e.target.value || null;
                      // Replacement text only means anything under a CUSTOM
                      // mask. Leaving it behind would strand a value the input
                      // no longer shows, which would then apply invisibly.
                      const stillCustom = (next ?? clipCaptionMode) === "CUSTOM";
                      onSetWordCensorOptions(selectedCensorable, {
                        captionMode: next,
                        ...(stillCustom ? {} : { replacement: null }),
                      });
                    }}
                    className="field py-0.5"
                  >
                    <option value="">
                      follow clip
                      {clipCaptionMode
                        ? ` (${CAPTION_CENSOR_MODES.find((m) => m.id === clipCaptionMode)?.sample})`
                        : ""}
                    </option>
                    {CAPTION_CENSOR_MODES.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} ({m.sample})
                      </option>
                    ))}
                  </select>
                </label>

                {(selectedCaptionMode ?? clipCaptionMode) === "CUSTOM" && (
                  <input
                    value={selectedReplacement ?? ""}
                    onChange={(e) =>
                      onSetWordCensorOptions(selectedCensorable, {
                        replacement: e.target.value || null,
                      })
                    }
                    placeholder={clipReplacement ?? "[BLEEP]"}
                    aria-label="Replacement text for these words"
                    className="field w-28 py-0.5"
                  />
                )}
              </>
            )}
          </div>

          {/* What the render will actually do with the selection, spelled out —
              the combination of four controls is not obvious from their states
              alone, and a wrong bleep is a publishable mistake. */}
          <p className="text-muted">{censorPreview}</p>
        </div>
      )}

      <ol className="max-h-64 overflow-y-auto">
        {rows.map((row, i) => (
          <li key={i} className="flex gap-3 px-3 py-1.5 text-sm leading-relaxed">
            <span className="shrink-0 self-start font-mono text-xs tabular-nums text-muted">
              {timecode(row.startMs)}
            </span>
            <span>
              {row.speaker ? <span className="text-muted">{row.speaker}: </span> : null}
              {row.words.length === 0 ? (
                <span
                  className={
                    q && row.text.toLowerCase().includes(q) ? "bg-amber-400/25 rounded px-0.5" : undefined
                  }
                >
                  {row.text}
                </span>
              ) : (
                row.words.map((w) => (
                  // The checkbox is a *sibling* of the word, never a child:
                  // the word itself is a button, and nesting one interactive
                  // control inside another breaks both keyboard and screen
                  // reader behaviour.
                  <span key={w.id} className="whitespace-nowrap">
                    {/* Only on the words you have actually selected — one on
                        every word in the transcript is unreadable noise. */}
                    {selectedIds.has(w.id) && onSetCensored && inClip(w) && (
                      <input
                        type="checkbox"
                        checked={censoredIds?.has(w.id) ?? false}
                        onChange={(e) => onSetCensored([w.id], e.target.checked)}
                        aria-label={`Censor "${w.text}"`}
                        title={`Censor this "${w.text}" only`}
                        className="mr-0.5 h-2.5 w-2.5 translate-y-px cursor-pointer accent-[rgb(var(--c-danger))] align-middle"
                      />
                    )}
                    {/* The audio, on its own axis: bleeping a word and masking
                        its caption are separate decisions. */}
                    {selectedIds.has(w.id) && onSetBleeped && inClip(w) && (
                      <input
                        type="checkbox"
                        checked={bleepedIds?.has(w.id) ?? false}
                        onChange={(e) => onSetBleeped([w.id], e.target.checked)}
                        aria-label={`Bleep "${w.text}" in the audio`}
                        title={`Bleep this "${w.text}" in the audio`}
                        className="mr-0.5 h-2.5 w-2.5 translate-y-px cursor-pointer accent-[rgb(var(--c-accent))] align-middle"
                      />
                    )}
                    <Word
                      word={w}
                      style={styles[w.id]}
                      selected={selectedIds.has(w.id)}
                      cut={cutIds?.has(w.id) && inClip(w)}
                      censored={censoredIds?.has(w.id) && inClip(w)}
                      bleeped={bleepedIds?.has(w.id) && inClip(w)}
                      audioMode={wordOverrides?.[w.id]?.audioMode ?? clipAudioMode}
                      outsideClip={!inClip(w)}
                      matched={matches.set.has(w.id)}
                      active={w.id === activeId}
                      onToggleSelect={onToggleSelect}
                      onSeek={onSeek}
                    />
                  </span>
                ))
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
});
