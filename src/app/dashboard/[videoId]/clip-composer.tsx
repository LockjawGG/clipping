"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type { TranscriptRow } from "./editable-transcript";

export function ClipComposer({ videoId }: { videoId: string }) {
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
    </section>
  );
}
