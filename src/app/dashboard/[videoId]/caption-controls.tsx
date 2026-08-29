"use client";

import { memo, useState } from "react";
import { useRouter } from "next/navigation";

import type { CaptionTemplate } from "@/lib/captions/preset-library.ts";
import type { TextStyle } from "@/lib/captions/text-style.ts";
import { parseStylePartial } from "@/lib/captions/text-style.ts";
import { parseRich, serializeRich } from "@/lib/captions/rich-extras.ts";
import { parseWordRules, serializeWordRules } from "@/lib/captions/word-rules.ts";
import { TemplateBrowser, splitTemplate } from "./caption-templates";
import { StyleControls } from "./style-controls";

/** The current config as a full TextStyle partial (scalar fields + rich blob). */
function stylePartialFromConfig(c: CaptionConfig): Partial<TextStyle> {
  return {
    fontFamily: c.fontFamily,
    fontWeight: c.fontWeight,
    fontSizePx: c.fontSizePx,
    textColor: c.textColor,
    highlightColor: c.highlightColor,
    outlineColor: c.outlineColor,
    outlineWidthPx: c.outlineWidthPx,
    backgroundColor: c.backgroundColor,
    alignment: c.alignment,
    positionY: c.positionY,
    uppercase: c.uppercase,
    ...(parseStylePartial(c.styleJson) as Partial<TextStyle>),
  };
}

/** TextStyle fields that map to scalar SubtitleConfig columns (vs the styleJson blob). */
const SCALAR_KEYS = new Set<string>([
  "fontFamily",
  "fontWeight",
  "fontSizePx",
  "textColor",
  "highlightColor",
  "outlineColor",
  "outlineWidthPx",
  "backgroundColor",
  "alignment",
  "uppercase",
]);

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
  /** Rich extras (fill, effect layers, letterSpacing…) as JSON, or null. */
  styleJson: string | null;
  /** WordRule[] as JSON, or null. */
  wordRulesJson: string | null;
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
  styleJson: null,
  wordRulesJson: null,
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
    styleJson: c.styleJson,
    wordRulesJson: c.wordRulesJson,
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

  /** A TextStyle patch from the shared panel → scalar columns + the styleJson blob. */
  const applyStylePatch = (patch: Partial<TextStyle>) => {
    const next = { ...value } as CaptionConfig & Record<string, unknown>;
    const rich: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (SCALAR_KEYS.has(k)) next[k] = v;
      else rich[k] = v;
    }
    if (Object.keys(rich).length) {
      next.styleJson = serializeRich({ ...parseRich(value.styleJson), ...rich });
    }
    onChange(next);
  };

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

  const putCaptions = (c: CaptionConfig) =>
    fetch(`/api/clips/${clipId}/captions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toPayload(c)),
    });

  const toggle = async () => {
    const next = !captionsOn;
    const ok = await run("toggle", () =>
      next ? putCaptions(value) : fetch(`/api/clips/${clipId}/captions`, { method: "DELETE" }),
    );
    if (ok) onCaptionsOnChange(next);
  };

  const saveStyle = () => run("save", () => putCaptions(value));

  const [appliedTemplate, setAppliedTemplate] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);

  const saveAsTemplate = async () => {
    const name = window.prompt("Name this style")?.trim();
    if (!name) return;
    await run("save", async () => {
      const res = await fetch("/api/text-presets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          kind: "caption",
          style: JSON.stringify(stylePartialFromConfig(value)),
          animation: value.animation,
          wordRules: value.wordRulesJson,
        }),
      });
      if (res.ok) setSavedTick((n) => n + 1);
      return res;
    });
  };

  const applyTemplate = async (t: CaptionTemplate) => {
    const { scalar, styleJson, wordRulesJson } = splitTemplate(t);
    const next = {
      ...value,
      ...scalar,
      animation: t.animation,
      styleJson,
      wordRulesJson,
    } as CaptionConfig;
    onChange(next);
    setAppliedTemplate(t.id);
    const ok = await run("save", () => putCaptions(next));
    if (ok && !captionsOn) onCaptionsOnChange(true);
  };

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

      <TemplateBrowser
        disabled={busy !== null}
        activeId={appliedTemplate}
        savedTick={savedTick}
        onApply={applyTemplate}
      />

      <details className="group rounded-lg border border-border bg-surface open:pb-2">
        <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted marker:content-none hover:text-text">
          <span className="inline-block transition-transform group-open:rotate-90">▸</span> Customize
          style
        </summary>
        <fieldset
          disabled={!captionsOn || busy !== null}
          className="flex flex-col gap-3 px-3 pt-1 disabled:opacity-50"
        >
          <label className="flex w-40 flex-col gap-1">
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

          <StyleControls
            style={stylePartialFromConfig(value)}
            onStyle={applyStylePatch}
            wordRules={parseWordRules(value.wordRulesJson)}
            onWordRules={(r) => set("wordRulesJson", serializeWordRules(r))}
          />

          <div className="flex flex-wrap items-center gap-4 text-xs">
            <span className="text-muted">y {(value.positionY * 100).toFixed(0)}%</span>
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

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={saveStyle} className="btn btn-sm">
              {busy === "save" ? "…" : "Save style"}
            </button>
            <button
              type="button"
              onClick={saveAsTemplate}
              className="btn btn-ghost btn-sm"
              title="Save this look to the “Mine” tab"
            >
              Save as template
            </button>
          </div>
        </fieldset>
      </details>

      {error && <p className="text-danger">{error}</p>}
      {!exists && captionsOn && (
        <p className="text-xs text-muted">Not saved yet — hit “Save style” or re-render.</p>
      )}
    </div>
  );
});
