"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewClipForm({ videoId }: { videoId: string }) {
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
    <form onSubmit={add} className="flex flex-wrap items-end gap-2 text-sm">
      <label className="flex flex-col gap-1">
        start (s)
        <input
          type="number"
          min={0}
          step={0.1}
          required
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="w-20 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>
      <label className="flex flex-col gap-1">
        end (s)
        <input
          type="number"
          min={0}
          step={0.1}
          required
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="w-20 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>
      <label className="flex flex-1 flex-col gap-1">
        title (optional)
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-neutral-900 px-3 py-1 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
      >
        {busy ? "…" : "Add clip"}
      </button>
      {error && <p className="w-full text-red-600">{error}</p>}
    </form>
  );
}
