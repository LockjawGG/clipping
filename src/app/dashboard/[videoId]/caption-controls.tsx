"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const ANIMATIONS = ["NONE", "WORD_BY_WORD", "POP", "SCALE", "BOUNCE", "FADE", "KARAOKE"] as const;
const PRESETS = ["CLASSIC", "BOLD", "VIRAL", "MINIMAL", "KARAOKE"] as const;

export interface CaptionConfig {
  preset: string;
  animation: string;
  textColor: string;
  highlightColor: string;
  positionY: number;
  uppercase: boolean;
}

const DEFAULTS: CaptionConfig = {
  preset: "CLASSIC",
  animation: "WORD_BY_WORD",
  textColor: "#FFFFFF",
  highlightColor: "#FFE600",
  positionY: 0.78,
  uppercase: false,
};

export function CaptionControls({ clipId, current }: { clipId: string; current: CaptionConfig | null }) {
  const router = useRouter();
  const [cfg, setCfg] = useState<CaptionConfig>(current ?? DEFAULTS);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "save" | "remove", req: () => Promise<Response>) {
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
    run("save", () =>
      fetch(`/api/clips/${clipId}/captions`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      }),
    );

  const remove = () =>
    run("remove", () => fetch(`/api/clips/${clipId}/captions`, { method: "DELETE" }));

  return (
    <div className="flex flex-col gap-2 rounded bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1">
          animation
          <select
            value={cfg.animation}
            onChange={(e) => setCfg({ ...cfg, animation: e.target.value })}
            className="rounded border border-neutral-300 px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-950"
          >
            {ANIMATIONS.map((a) => (
              <option key={a} value={a}>
                {a.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          preset
          <select
            value={cfg.preset}
            onChange={(e) => setCfg({ ...cfg, preset: e.target.value })}
            className="rounded border border-neutral-300 px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-950"
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {p.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          text
          <input
            type="color"
            value={cfg.textColor}
            onChange={(e) => setCfg({ ...cfg, textColor: e.target.value.toUpperCase() })}
          />
        </label>
        <label className="flex items-center gap-1">
          highlight
          <input
            type="color"
            value={cfg.highlightColor}
            onChange={(e) => setCfg({ ...cfg, highlightColor: e.target.value.toUpperCase() })}
          />
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={cfg.uppercase}
            onChange={(e) => setCfg({ ...cfg, uppercase: e.target.checked })}
          />
          uppercase
        </label>
        <label className="flex items-center gap-2">
          y
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={cfg.positionY}
            onChange={(e) => setCfg({ ...cfg, positionY: Number(e.target.value) })}
          />
          <span className="tabular-nums">{cfg.positionY.toFixed(2)}</span>
        </label>
      </div>

      {error && <p className="text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy !== null}
          className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-40 dark:border-neutral-700"
        >
          {busy === "save" ? "…" : "Save captions"}
        </button>
        {current && (
          <button
            onClick={remove}
            disabled={busy !== null}
            className="rounded border border-neutral-300 px-3 py-1 text-neutral-500 disabled:opacity-40 dark:border-neutral-700"
          >
            {busy === "remove" ? "…" : "Remove captions"}
          </button>
        )}
      </div>
    </div>
  );
}
