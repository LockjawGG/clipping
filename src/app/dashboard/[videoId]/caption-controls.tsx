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
  animation: "NONE",
  textColor: "#FFFFFF",
  highlightColor: "#FFE600",
  positionY: 0.78,
  uppercase: false,
};

interface Props {
  clipId: string;
  current: CaptionConfig | null;
  captionsOn: boolean;
  onCaptionsOnChange: (on: boolean) => void;
}

export function CaptionControls({ clipId, current, captionsOn, onCaptionsOnChange }: Props) {
  const router = useRouter();
  const [cfg, setCfg] = useState<CaptionConfig>(current ?? DEFAULTS);
  const [busy, setBusy] = useState<"toggle" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "toggle" | "save", req: () => Promise<Response>) {
    setBusy(kind);
    setError(null);
    try {
      const res = await req();
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${kind} failed`);
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      return false;
    } finally {
      setBusy(null);
    }
  }

  const toggle = async () => {
    const next = !captionsOn;
    const ok = await run("toggle", () =>
      next
        ? fetch(`/api/clips/${clipId}/captions`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        : fetch(`/api/clips/${clipId}/captions`, { method: "DELETE" }),
    );
    if (ok) onCaptionsOnChange(next);
  };

  const saveStyle = () =>
    run("save", () =>
      fetch(`/api/clips/${clipId}/captions`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      }),
    );

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface-raised p-3 text-sm">
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={captionsOn}
          aria-label="Toggle subtitles"
          disabled={busy !== null}
          onClick={toggle}
          className="switch"
        />
        <div className="flex flex-col leading-tight">
          <span className="font-medium text-text">Subtitles {captionsOn ? "on" : "off"}</span>
          <span className="text-xs text-muted">
            {captionsOn ? "Burned into the render · preview above" : "The render will have no captions"}
          </span>
        </div>
        {busy === "toggle" && <span className="text-xs text-muted">…</span>}
      </div>

      <details className="group rounded-lg border border-border bg-surface open:pb-1">
        <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted marker:content-none hover:text-text">
          <span className="inline-block transition-transform group-open:rotate-90">▸</span> Customize
          style
        </summary>
        <fieldset
          disabled={!captionsOn || busy !== null}
          className="flex flex-col gap-3 px-3 pt-1 disabled:opacity-50"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5">
              preset
              <select
                value={cfg.preset}
                onChange={(e) => setCfg({ ...cfg, preset: e.target.value })}
                className="field py-1"
              >
                {PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p.toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              animation
              <select
                value={cfg.animation}
                onChange={(e) => setCfg({ ...cfg, animation: e.target.value })}
                className="field py-1"
              >
                {ANIMATIONS.map((a) => (
                  <option key={a} value={a}>
                    {a.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              text
              <input
                type="color"
                value={cfg.textColor}
                onChange={(e) => setCfg({ ...cfg, textColor: e.target.value.toUpperCase() })}
                className="h-7 w-9 rounded border border-border bg-surface"
              />
            </label>
            <label className="flex items-center gap-1.5">
              highlight
              <input
                type="color"
                value={cfg.highlightColor}
                onChange={(e) => setCfg({ ...cfg, highlightColor: e.target.value.toUpperCase() })}
                className="h-7 w-9 rounded border border-border bg-surface"
              />
            </label>
            <label className="flex items-center gap-1.5">
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
              <span className="font-mono tabular-nums text-muted">{cfg.positionY.toFixed(2)}</span>
            </label>
          </div>
          <button type="button" onClick={saveStyle} className="btn btn-sm self-start">
            {busy === "save" ? "…" : "Save style"}
          </button>
        </fieldset>
      </details>

      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}
