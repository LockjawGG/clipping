"use client";

import { memo, useState } from "react";
import { useRouter } from "next/navigation";

const ANIMATIONS = [
  "NONE",
  "WORD_BY_WORD",
  "POP",
  "SCALE",
  "BOUNCE",
  "FADE",
  "KARAOKE",
  "SLIDE_UP",
  "TYPEWRITER",
] as const;
const PRESETS = ["CLASSIC", "BOLD", "VIRAL", "MINIMAL", "KARAOKE"] as const;
export const CAPTION_FONTS = ["Inter", "Archivo Black", "Georgia", "JetBrains Mono"] as const;
const WEIGHTS = [400, 600, 700, 800, 900] as const;

export interface CaptionConfig {
  preset: string;
  animation: string;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidthPx: number;
  backgroundColor: string | null;
  alignment: "left" | "center" | "right";
  positionY: number;
  maxLines: number;
  maxWordsPerCue: number;
  uppercase: boolean;
}

export const CAPTION_DEFAULTS: CaptionConfig = {
  preset: "CLASSIC",
  animation: "NONE",
  fontFamily: "Inter",
  fontSizePx: 64,
  fontWeight: 800,
  textColor: "#FFFFFF",
  highlightColor: "#FFE600",
  outlineColor: "#000000",
  outlineWidthPx: 6,
  backgroundColor: null,
  alignment: "center",
  positionY: 0.78,
  maxLines: 2,
  maxWordsPerCue: 7,
  uppercase: false,
};

/** The subset the caption `PUT` accepts (strips preset-derived noise). */
function toPayload(c: CaptionConfig) {
  return {
    preset: c.preset,
    animation: c.animation,
    fontFamily: c.fontFamily,
    fontSizePx: Math.round(c.fontSizePx),
    fontWeight: c.fontWeight,
    textColor: c.textColor,
    highlightColor: c.highlightColor,
    outlineColor: c.outlineColor,
    outlineWidthPx: Math.round(c.outlineWidthPx),
    backgroundColor: c.backgroundColor,
    alignment: c.alignment,
    positionY: Number(c.positionY.toFixed(3)),
    maxLines: c.maxLines,
    maxWordsPerCue: c.maxWordsPerCue,
    uppercase: c.uppercase,
  };
}

interface Props {
  clipId: string;
  exists: boolean;
  captionsOn: boolean;
  onCaptionsOnChange: (on: boolean) => void;
  value: CaptionConfig;
  onChange: (next: CaptionConfig) => void;
}

export const CaptionControls = memo(function CaptionControls({
  clipId,
  exists,
  captionsOn,
  onCaptionsOnChange,
  value,
  onChange,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"toggle" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof CaptionConfig>(k: K, v: CaptionConfig[K]) =>
    onChange({ ...value, [k]: v });

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
            body: JSON.stringify(toPayload(value)),
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
        body: JSON.stringify(toPayload(value)),
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
            {captionsOn
              ? "Burned into the render · drag the caption in the preview to place it"
              : "The render will have no captions"}
          </span>
        </div>
        {busy === "toggle" && <span className="text-xs text-muted">…</span>}
      </div>

      <details className="group rounded-lg border border-border bg-surface open:pb-2">
        <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted marker:content-none hover:text-text">
          <span className="inline-block transition-transform group-open:rotate-90">▸</span> Customize
          style
        </summary>
        <fieldset
          disabled={!captionsOn || busy !== null}
          className="flex flex-col gap-3 px-3 pt-1 disabled:opacity-50"
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">preset</span>
              <select
                value={value.preset}
                onChange={(e) => set("preset", e.target.value)}
                className="field py-1"
              >
                {PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p.toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">animation</span>
              <select
                value={value.animation}
                onChange={(e) => set("animation", e.target.value)}
                className="field py-1"
              >
                {ANIMATIONS.map((a) => (
                  <option key={a} value={a}>
                    {a.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">font</span>
              <select
                value={value.fontFamily}
                onChange={(e) => set("fontFamily", e.target.value)}
                className="field py-1"
              >
                {CAPTION_FONTS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">weight</span>
              <select
                value={value.fontWeight}
                onChange={(e) => set("fontWeight", Number(e.target.value))}
                className="field py-1"
              >
                {WEIGHTS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
            <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
              <span className="text-xs text-muted">size · {value.fontSizePx}px</span>
              <input
                type="range"
                min={24}
                max={160}
                step={2}
                value={value.fontSizePx}
                onChange={(e) => set("fontSizePx", Number(e.target.value))}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5">
              text
              <input
                type="color"
                value={value.textColor}
                onChange={(e) => set("textColor", e.target.value.toUpperCase())}
                className="h-7 w-9 rounded border border-border bg-surface"
              />
            </label>
            <label className="flex items-center gap-1.5">
              highlight
              <input
                type="color"
                value={value.highlightColor}
                onChange={(e) => set("highlightColor", e.target.value.toUpperCase())}
                className="h-7 w-9 rounded border border-border bg-surface"
              />
            </label>
            <label className="flex items-center gap-1.5">
              outline
              <input
                type="color"
                value={value.outlineColor}
                onChange={(e) => set("outlineColor", e.target.value.toUpperCase())}
                className="h-7 w-9 rounded border border-border bg-surface"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-xs text-muted">outline {value.outlineWidthPx}</span>
              <input
                type="range"
                min={0}
                max={24}
                step={1}
                value={value.outlineWidthPx}
                onChange={(e) => set("outlineWidthPx", Number(e.target.value))}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={value.backgroundColor !== null}
                onChange={(e) => set("backgroundColor", e.target.checked ? "#000000" : null)}
              />
              background box
            </label>
            {value.backgroundColor !== null && (
              <input
                type="color"
                value={value.backgroundColor}
                onChange={(e) => set("backgroundColor", e.target.value.toUpperCase())}
                className="h-7 w-9 rounded border border-border bg-surface"
              />
            )}
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={value.uppercase}
                onChange={(e) => set("uppercase", e.target.checked)}
              />
              uppercase
            </label>
            <span className="flex items-center gap-1.5">
              <span className="text-xs text-muted">align</span>
              <span className="seg">
                {(["left", "center", "right"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    aria-pressed={value.alignment === a}
                    onClick={() => set("alignment", a)}
                  >
                    {a}
                  </button>
                ))}
              </span>
            </span>
            <span className="text-xs text-muted">
              y {(value.positionY * 100).toFixed(0)}%
            </span>
          </div>

          <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
            <summary className="cursor-pointer text-muted">Advanced line wrapping</summary>
            <div className="flex flex-wrap items-center gap-4 pt-2">
              <label className="flex items-center gap-2">
                max lines
                <input
                  type="number"
                  min={1}
                  max={3}
                  value={value.maxLines}
                  onChange={(e) => set("maxLines", Number(e.target.value))}
                  className="field w-16 py-0.5"
                />
              </label>
              <label className="flex items-center gap-2">
                words / cue
                <input
                  type="number"
                  min={2}
                  max={12}
                  value={value.maxWordsPerCue}
                  onChange={(e) => set("maxWordsPerCue", Number(e.target.value))}
                  className="field w-16 py-0.5"
                />
              </label>
            </div>
          </details>

          <button type="button" onClick={saveStyle} className="btn btn-sm self-start">
            {busy === "save" ? "…" : "Save style"}
          </button>
        </fieldset>
      </details>

      {error && <p className="text-danger">{error}</p>}
      {!exists && captionsOn && (
        <p className="text-xs text-muted">Not saved yet — hit “Save style” or re-render.</p>
      )}
    </div>
  );
});
