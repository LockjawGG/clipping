"use client";

import { memo, useEffect, useMemo, useState } from "react";

import type { TextStyle } from "@/lib/captions/text-style.ts";
import { parseStylePartial, serializeStylePartial } from "@/lib/captions/text-style.ts";
import type { ElementAnimSpec } from "@/lib/captions/element-anim.ts";
import { parseElementAnim, serializeElementAnim } from "@/lib/captions/element-anim.ts";
import { TEXT_OVERLAY_ROLES } from "@/lib/overlays/roles.ts";
import { MotionControls } from "./motion-controls";
import { StyleControls } from "./style-controls";

interface Props {
  text: string;
  role: string;
  styleJson: string | null;
  animationJson: string | null;
  /** False when the layer has no end time, so an outro can never fire. */
  hasEnd?: boolean;
  onEdit: (patch: Record<string, unknown>, opts?: { coalesceMs?: number }) => void;
}

/**
 * The inspector for an inserted text caption. Shares the whole style panel
 * (`StyleControls`) with transcribed subtitles and the whole motion panel
 * (`MotionControls`) with every other animatable element — only the content
 * field and the role are specific to a freestanding text layer.
 */
export const TextOverlayInspector = memo(function TextOverlayInspector({
  text,
  role,
  styleJson,
  animationJson,
  hasEnd = true,
  onEdit,
}: Props) {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);

  const anim = useMemo(() => parseElementAnim(animationJson), [animationJson]);
  const setAnim = (p: Partial<ElementAnimSpec>, opts?: { coalesceMs?: number }) =>
    onEdit({ animationJson: serializeElementAnim({ ...anim, ...p }) }, opts);

  const style = useMemo(() => parseStylePartial(styleJson), [styleJson]);
  const setStyle = (p: Partial<TextStyle>, opts?: { coalesceMs?: number }) =>
    onEdit({ styleJson: serializeStylePartial({ ...style, ...p }) }, opts);

  const commitText = () => {
    const v = draft.trim();
    if (v && v !== text) onEdit({ content: v });
    else if (!v) setDraft(text);
  };

  // saved text-style presets ("Mine")
  const [presets, setPresets] = useState<
    { id: string; name: string; style: string; animation: string }[]
  >([]);
  const loadPresets = () =>
    fetch("/api/text-presets?kind=text")
      .then((r) => (r.ok ? r.json() : []))
      .then(setPresets)
      .catch(() => {});
  useEffect(() => {
    void loadPresets();
  }, []);

  const saveAsPreset = async () => {
    const name = window.prompt("Name this text style")?.trim();
    if (!name) return;
    const res = await fetch("/api/text-presets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        kind: "text",
        style: serializeStylePartial(style) ?? "{}",
        animation: serializeElementAnim(anim) ?? "NONE",
      }),
    });
    if (res.ok) void loadPresets();
  };

  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    onEdit({
      styleJson: p.style === "{}" ? null : p.style,
      animationJson: p.animation === "NONE" ? null : p.animation,
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(text);
        }}
        placeholder="Text…"
        className="field w-full"
        aria-label="Caption text"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1">
          role
          <select
            value={role}
            onChange={(e) => onEdit({ role: e.target.value })}
            className="field py-0.5"
          >
            {TEXT_OVERLAY_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>

      <MotionControls anim={anim} onAnim={setAnim} canOutro={hasEnd} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={saveAsPreset} className="btn btn-ghost btn-sm">
          Save as template
        </button>
        {presets.length > 0 && (
          <select
            defaultValue=""
            aria-label="Apply a saved text style"
            onChange={(e) => {
              if (e.target.value) applyPreset(e.target.value);
              e.target.value = "";
            }}
            className="field py-0.5"
          >
            <option value="" disabled>
              Apply saved…
            </option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <StyleControls style={style} onStyle={setStyle} />
    </div>
  );
});
