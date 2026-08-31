"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { snapToSentences, DEFAULT_SNAP_CONFIG } from "@/lib/clips/boundaries.ts";
import type { TranscriptRow } from "./editable-transcript";

export type { TranscriptRow } from "./editable-transcript";

export function ClipComposer({
  videoId,
  segments,
  videoDurationMs,
}: {
  videoId: string;
  /** Every segment of the video, so the form can show what it will really make. */
  segments: TranscriptRow[];
  videoDurationMs: number;
}) {
  const router = useRouter();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * What "Add clip" will actually create.
   *
   * A manual clip is snapped out to whole sentences and up to a minimum length,
   * so asking for 2s–6s of this video produces 4.0s–20.1s. That is deliberate —
   * a clip that starts mid-word is not worth making — but it happened silently,
   * and the numbers you typed were nowhere in the result. Running the same
   * `snapToSentences` the server will run means the form can say so first.
   */
  const snapped = useMemo(() => {
    const from = Number(start);
    const to = Number(end);
    if (start === "" || end === "" || !Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (to <= from) return null;
    const result = snapToSentences(
      { startMs: Math.round(from * 1000), endMs: Math.round(to * 1000) },
      segments as Parameters<typeof snapToSentences>[1],
      videoDurationMs,
    );
    // `rejectedReason` is advice, not a refusal: the creation path takes the
    // snapped range either way, so saying "can't place that" here would be this
    // form inventing a rule the server does not have. It is worth repeating
    // though — it is the reason the range moved.
    const moved =
      Math.abs(result.startMs - from * 1000) > 50 || Math.abs(result.endMs - to * 1000) > 50;
    return {
      startMs: result.startMs,
      endMs: result.endMs,
      moved,
      note: result.rejectedReason ?? null,
    };
  }, [start, end, segments, videoDurationMs]);

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

        {snapped && (
          <p className="w-full text-xs text-muted">
            {snapped.moved ? (
              <>
                Will create{" "}
                <span className="font-mono tabular-nums text-fg">
                  {(snapped.startMs / 1000).toFixed(1)}s–{(snapped.endMs / 1000).toFixed(1)}s
                </span>{" "}
                — snapped out to whole sentences, aiming for at least{" "}
                {DEFAULT_SNAP_CONFIG.minClipMs / 1000}s.
                {snapped.note ? ` This one ${snapped.note}.` : ""}
              </>
            ) : (
              <>Will create exactly that range.</>
            )}
          </p>
        )}
      </form>
    </section>
  );
}
