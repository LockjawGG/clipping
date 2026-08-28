"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface TranscriptWord {
  id: string;
  text: string;
}
export interface TranscriptRow {
  startMs: number;
  endMs: number;
  speaker: string | null;
  words: TranscriptWord[];
}

const timecode = (ms: number) => {
  const t = Math.round(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** One transcript word: click to correct a typo. Timings are never touched. */
export function EditableWord({ word }: { word: TranscriptWord }) {
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
      onClick={() => setEditing(true)}
      className={`rounded px-0.5 hover:bg-accent/15 ${busy ? "opacity-50" : ""}`}
      title="Click to edit"
    >
      {value}
    </button>
  );
}

/** Read-only-layout transcript with click-to-edit words. */
export function EditableTranscript({ rows }: { rows: TranscriptRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted">No transcript for this range.</p>;
  }
  return (
    <ol className="max-h-64 overflow-y-auto rounded-lg border border-border bg-surface-raised">
      {rows.map((row, i) => (
        <li key={i} className="flex gap-3 px-3 py-1.5 text-sm leading-relaxed">
          <span className="shrink-0 self-start font-mono text-xs tabular-nums text-muted">
            {timecode(row.startMs)}
          </span>
          <span>
            {row.speaker ? <span className="text-muted">{row.speaker}: </span> : null}
            {row.words.map((w) => (
              <EditableWord key={w.id} word={w} />
            ))}
          </span>
        </li>
      ))}
    </ol>
  );
}
