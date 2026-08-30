"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

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
  word,
  style,
  selected,
  matched,
  active,
  onToggleSelect,
  onSeek,
}: {
  /** Currently masked by the clip's censor settings. */
  censored?: boolean;
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
      style={wordSpanCss(style)}
      className={`rounded px-0.5 ${busy ? "opacity-50" : ""} ${
        selected
          ? "bg-accent/30 ring-1 ring-accent"
          : active
            ? "bg-amber-400/60 ring-1 ring-amber-500"
            : matched
              ? "bg-amber-400/25"
              : "hover:bg-accent/15"
      } ${
        // Marked even while selected, so you can see what you are exempting.
        censored ? "line-through decoration-2 decoration-danger" : ""
      }`}
      title={
        censored
          ? "Censored in this clip - select it and choose “Don’t censor” to keep it"
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
  /** Word ids the clip's censor settings would currently mask. */
  censoredIds?: ReadonlySet<string>;
  /**
   * Exempt these words from censoring on this clip only. Takes the words'
   * text — the exemption is per-clip and never edits the shared lexicon.
   */
  onUncensor?: (texts: string[]) => void;
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
  onUncensor,
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

  /** Selected words that censoring would currently mask, de-duplicated. */
  const selectedCensored = useMemo(() => {
    if (!censoredIds || censoredIds.size === 0) return [] as string[];
    const seen = new Set<string>();
    for (const row of rows)
      for (const w of row.words)
        if (selectedIds.has(w.id) && censoredIds.has(w.id)) {
          const key = w.text.toLowerCase().replace(/[^\p{L}']/gu, "");
          if (key) seen.add(key);
        }
    return [...seen];
  }, [rows, selectedIds, censoredIds]);

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
          {onUncensor && selectedCensored.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-accent"
              title="Stop censoring these words on this clip. The shared word list is unchanged."
              onClick={() => onUncensor(selectedCensored)}
            >
              Don&apos;t censor {selectedCensored.length === 1 ? `"${selectedCensored[0]}"` : `these ${selectedCensored.length}`}
            </button>
          )}
          <button type="button" onClick={onClearSelection} className="btn btn-ghost btn-sm ml-auto">
            Done
          </button>
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
                <Word
                  key={w.id}
                  word={w}
                  style={styles[w.id]}
                  selected={selectedIds.has(w.id)}
                  censored={censoredIds?.has(w.id)}
                  matched={matches.set.has(w.id)}
                  active={w.id === activeId}
                  onToggleSelect={onToggleSelect}
                  onSeek={onSeek}
                />
                ))
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
});
