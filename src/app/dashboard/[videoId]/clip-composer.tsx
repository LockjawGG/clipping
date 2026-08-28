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

const secs = (ms: number) => (ms / 1000).toFixed(1);
const timecode = (ms: number) => {
  const t = Math.round(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** One transcript word: click to correct a typo. Timings are never touched. */
function EditableWord({ word }: { word: TranscriptWord }) {
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
        className="mx-0.5 rounded border border-accent/60 bg-surface px-1 py-0 text-sm outline-none"
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

export function ClipComposer({ videoId, rows }: { videoId: string; rows: TranscriptRow[] }) {
  const router = useRouter();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/clips`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startMs: Math.round(Number(start) * 1000),
          endMs: Math.round(Number(end) * 1000),
          title: title || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "could not add clip");
      setStart("");
      setEnd("");
      setTitle("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-col gap-4 p-5">
      <h2 className="text-lg font-semibold">New clip</h2>

      <form onSubmit={add} className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">start (s)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="field w-24 font-mono tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">end (s)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            required
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="field w-24 font-mono tabular-nums"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted">title (optional)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="field"
            placeholder="Untitled clip"
          />
        </label>
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? "…" : "Add clip"}
        </button>
        {error && <p className="w-full text-danger">{error}</p>}
      </form>

      {rows.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted">
            Transcript — click a word to fix a typo, or a timecode to load it into the form.
          </p>
          <ol className="max-h-96 overflow-y-auto rounded-lg border border-border">
            {rows.map((row, i) => (
              <li key={i} className="flex gap-3 px-3 py-1.5 text-sm leading-relaxed">
                <button
                  type="button"
                  onClick={() => {
                    setStart(secs(row.startMs));
                    setEnd(secs(row.endMs));
                  }}
                  className="shrink-0 self-start rounded px-1 font-mono text-xs tabular-nums text-muted hover:bg-surface-raised"
                >
                  {timecode(row.startMs)}
                </button>
                <span>
                  {row.speaker ? <span className="text-muted">{row.speaker}: </span> : null}
                  {row.words.map((w) => (
                    <EditableWord key={w.id} word={w} />
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
