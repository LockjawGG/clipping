"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface TranscriptRow {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
}

const secs = (ms: number) => (ms / 1000).toFixed(1);
const timecode = (ms: number) => {
  const t = Math.round(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

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

  function pick(row: TranscriptRow) {
    // First click sets the start (and a provisional end); adjust end by clicking
    // a later line, or edit the fields directly.
    if (!start || Number(end) <= Number(secs(row.startMs))) {
      setStart(secs(row.startMs));
      setEnd(secs(row.endMs));
    } else {
      setEnd(secs(row.endMs));
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
            Transcript — click a line to load its time into the form.
          </p>
          <ol className="max-h-80 overflow-y-auto rounded-lg border border-border">
            {rows.map((row, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => pick(row)}
                  className="flex w-full gap-3 px-3 py-1.5 text-left text-sm hover:bg-surface-raised"
                >
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                    {timecode(row.startMs)}
                  </span>
                  <span>
                    {row.speaker ? <span className="text-muted">{row.speaker}: </span> : null}
                    {row.text}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
