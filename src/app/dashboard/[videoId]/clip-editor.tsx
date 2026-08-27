"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { CaptionControls, type CaptionConfig } from "./caption-controls";

const ASPECTS = [
  ["VERTICAL_9_16", "9:16"],
  ["SQUARE_1_1", "1:1"],
  ["LANDSCAPE_16_9", "16:9"],
  ["PORTRAIT_4_5", "4:5"],
] as const;

export interface ClipData {
  id: string;
  origin: string;
  title: string;
  startMs: number;
  endMs: number;
  score: number | null;
  aspectRatio: string;
  focalX: number | null;
  focalY: number | null;
  accepted: boolean;
  captions: CaptionConfig | null;
  render: { id: string; status: string; progress: number; downloadUrl: string | null } | null;
}

const s = (ms: number) => (ms / 1000).toFixed(1);

export function ClipEditor({ clip }: { clip: ClipData }) {
  const router = useRouter();
  const [draft, setDraft] = useState(clip);
  const [busy, setBusy] = useState<"save" | "render" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    draft.title !== clip.title ||
    draft.startMs !== clip.startMs ||
    draft.endMs !== clip.endMs ||
    draft.aspectRatio !== clip.aspectRatio ||
    draft.focalX !== clip.focalX ||
    draft.focalY !== clip.focalY ||
    draft.accepted !== clip.accepted;

  async function call(kind: "save" | "render" | "delete", req: () => Promise<Response>) {
    setBusy(kind);
    setError(null);
    try {
      const res = await req();
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${kind} failed`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    call("save", () =>
      fetch(`/api/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          startMs: Math.round(draft.startMs),
          endMs: Math.round(draft.endMs),
          aspectRatio: draft.aspectRatio,
          focalX: draft.focalX,
          focalY: draft.focalY,
          accepted: draft.accepted,
        }),
      }),
    );

  const render = () => call("render", () => fetch(`/api/clips/${clip.id}/render`, { method: "POST" }));
  const remove = () => call("delete", () => fetch(`/api/clips/${clip.id}`, { method: "DELETE" }));

  const nudge = (field: "startMs" | "endMs", deltaMs: number) =>
    setDraft((d) => ({ ...d, [field]: Math.max(0, d[field] + deltaMs) }));

  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center gap-2">
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm font-medium dark:border-neutral-700 dark:bg-neutral-900"
        />
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
          {draft.origin === "USER_CREATED" ? "manual" : "AI"}
          {draft.score !== null ? ` · ${draft.score.toFixed(2)}` : ""}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="flex items-center gap-1">
          start
          <button onClick={() => nudge("startMs", -1000)} className="rounded border px-1.5 dark:border-neutral-700">−</button>
          <span className="w-12 text-center tabular-nums">{s(draft.startMs)}s</span>
          <button onClick={() => nudge("startMs", 1000)} className="rounded border px-1.5 dark:border-neutral-700">+</button>
        </span>
        <span className="flex items-center gap-1">
          end
          <button onClick={() => nudge("endMs", -1000)} className="rounded border px-1.5 dark:border-neutral-700">−</button>
          <span className="w-12 text-center tabular-nums">{s(draft.endMs)}s</span>
          <button onClick={() => nudge("endMs", 1000)} className="rounded border px-1.5 dark:border-neutral-700">+</button>
        </span>
        <label className="flex items-center gap-1">
          aspect
          <select
            value={draft.aspectRatio}
            onChange={(e) => setDraft({ ...draft, aspectRatio: e.target.value })}
            className="rounded border border-neutral-300 px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-900"
          >
            {ASPECTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={draft.accepted}
            onChange={(e) => setDraft({ ...draft, accepted: e.target.checked })}
          />
          accepted
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        {(["focalX", "focalY"] as const).map((axis) => (
          <label key={axis} className="flex items-center gap-2">
            {axis === "focalX" ? "focal X" : "focal Y"}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft[axis] ?? 0.5}
              onChange={(e) => setDraft({ ...draft, [axis]: Number(e.target.value) })}
            />
            <span className="tabular-nums">{(draft[axis] ?? 0.5).toFixed(2)}</span>
          </label>
        ))}
      </div>

      <CaptionControls clipId={clip.id} current={clip.captions} />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-2 text-sm">
        <button
          onClick={save}
          disabled={!dirty || busy !== null}
          className="rounded bg-neutral-900 px-3 py-1 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          {busy === "save" ? "…" : "Save"}
        </button>
        <button
          onClick={render}
          disabled={busy !== null}
          className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40 dark:border-neutral-700"
        >
          {busy === "render" ? "…" : clip.render ? "Re-render" : "Render"}
        </button>
        <button
          onClick={remove}
          disabled={busy !== null}
          className="rounded border border-red-300 px-3 py-1 text-red-600 disabled:opacity-40 dark:border-red-800"
        >
          Delete
        </button>
        {clip.render && (
          <span className="text-xs text-neutral-500">
            render: {clip.render.status.toLowerCase()}
            {clip.render.status !== "COMPLETED" && clip.render.status !== "FAILED"
              ? ` (${Math.round(clip.render.progress * 100)}%)`
              : ""}
            {clip.render.downloadUrl && (
              <>
                {" · "}
                <a href={clip.render.downloadUrl} className="underline">
                  download
                </a>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
