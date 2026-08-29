"use client";

import { memo, useEffect, useMemo, useState } from "react";

import type { EffectLayer, EffectLayerKind, TextStyle } from "@/lib/captions/text-style.ts";
import { parseStylePartial, serializeStylePartial } from "@/lib/captions/text-style.ts";
import { TEXT_OVERLAY_ROLES } from "@/lib/overlays/roles.ts";

const FONTS = ["Inter", "Archivo Black", "Georgia", "Impact", "JetBrains Mono"] as const;
const WEIGHTS = [400, 600, 700, 800, 900] as const;

const EFFECTS: { kind: EffectLayerKind; label: string; color: string; size: number; max: number }[] = [
  { kind: "glow", label: "Glow", color: "#8AB4FF", size: 14, max: 40 },
  { kind: "neon", label: "Neon", color: "#00E5FF", size: 9, max: 24 },
  { kind: "shadow-soft", label: "Soft shadow", color: "#000000", size: 12, max: 40 },
  { kind: "shadow-long", label: "Long shadow", color: "#1A1A1A", size: 12, max: 24 },
];

interface Props {
  text: string;
  role: string;
  styleJson: string | null;
  onEdit: (patch: Record<string, unknown>, opts?: { coalesceMs?: number }) => void;
}

export const TextOverlayInspector = memo(function TextOverlayInspector({
  text,
  role,
  styleJson,
  onEdit,
}: Props) {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);

  const style = useMemo(() => parseStylePartial(styleJson), [styleJson]);
  const setStyle = (p: Partial<TextStyle>, opts?: { coalesceMs?: number }) =>
    onEdit({ styleJson: serializeStylePartial({ ...style, ...p }) }, opts);

  const layers = style.layers ?? [];
  const setLayer = (kind: EffectLayerKind, next: EffectLayer | null) => {
    const kept = layers.filter((l) => l.kind !== kind);
    const merged = next ? [...kept, next] : kept;
    merged.sort(
      (a, b) => EFFECTS.findIndex((c) => c.kind === a.kind) - EFFECTS.findIndex((c) => c.kind === b.kind),
    );
    setStyle({ layers: merged });
  };

  const gradient = style.fill?.kind === "linear-gradient" ? style.fill : null;
  const stops = gradient?.stops ?? ["#FFD166", "#EF476F"];

  const commitText = () => {
    const v = draft.trim();
    if (v && v !== text) onEdit({ content: v });
    else if (!v) setDraft(text);
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
        aria-label="Overlay text"
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
        <label className="flex items-center gap-1">
          font
          <select
            value={style.fontFamily ?? "Inter"}
            onChange={(e) => setStyle({ fontFamily: e.target.value })}
            className="field py-0.5"
          >
            {FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          weight
          <select
            value={style.fontWeight ?? 700}
            onChange={(e) => setStyle({ fontWeight: Number(e.target.value) })}
            className="field py-0.5"
          >
            {WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="color"
            aria-label="text colour"
            value={style.textColor ?? "#FFFFFF"}
            onChange={(e) => setStyle({ textColor: e.target.value.toUpperCase() })}
            className="h-6 w-8 rounded border border-border bg-surface"
          />
        </label>
        <label className="flex items-center gap-1">
          size {style.fontSizePx ?? 64}
          <input
            type="range"
            min={16}
            max={200}
            step={2}
            value={style.fontSizePx ?? 64}
            onChange={(e) => setStyle({ fontSizePx: Number(e.target.value) }, { coalesceMs: 200 })}
          />
        </label>
        <span className="seg">
          {(["left", "center", "right"] as const).map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={(style.alignment ?? "center") === a}
              onClick={() => setStyle({ alignment: a })}
            >
              {a}
            </button>
          ))}
        </span>
      </div>

      <details className="rounded border border-border bg-surface px-2 py-1">
        <summary className="cursor-pointer text-muted">Effects &amp; fill</summary>
        <div className="flex flex-col gap-2 pt-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label className="flex items-center gap-2">
              spacing {(style.letterSpacingEm ?? 0).toFixed(2)}
              <input
                type="range"
                min={-0.05}
                max={0.4}
                step={0.01}
                value={style.letterSpacingEm ?? 0}
                onChange={(e) => setStyle({ letterSpacingEm: Number(e.target.value) }, { coalesceMs: 200 })}
              />
            </label>
            <label className="flex items-center gap-2">
              line {(style.lineHeight ?? 1.15).toFixed(2)}
              <input
                type="range"
                min={0.9}
                max={1.8}
                step={0.05}
                value={style.lineHeight ?? 1.15}
                onChange={(e) => setStyle({ lineHeight: Number(e.target.value) }, { coalesceMs: 200 })}
              />
            </label>
            <label className="flex items-center gap-1">
              case
              <select
                value={style.textTransform ?? "none"}
                onChange={(e) =>
                  setStyle({ textTransform: e.target.value as TextStyle["textTransform"] })
                }
                className="field py-0.5"
              >
                {(["none", "uppercase", "lowercase", "capitalize"] as const).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={!!style.glass}
                onChange={(e) => setStyle({ glass: e.target.checked })}
              />
              glass
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-2">
            <span className="text-muted">fill</span>
            <span className="seg">
              {(["solid", "gradient"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={(k === "gradient") === !!gradient}
                  onClick={() =>
                    setStyle({
                      fill:
                        k === "gradient"
                          ? { kind: "linear-gradient", stops, angleDeg: gradient?.angleDeg ?? 180 }
                          : { kind: "solid" },
                    })
                  }
                >
                  {k}
                </button>
              ))}
            </span>
            {gradient &&
              stops.map((c, i) => (
                <input
                  key={i}
                  type="color"
                  aria-label={`gradient colour ${i + 1}`}
                  value={c}
                  onChange={(e) => {
                    const next = [...stops];
                    next[i] = e.target.value.toUpperCase();
                    setStyle({ fill: { kind: "linear-gradient", stops: next, angleDeg: gradient.angleDeg ?? 180 } });
                  }}
                  className="h-6 w-8 rounded border border-border bg-surface"
                />
              ))}
            {gradient && (
              <label className="flex items-center gap-2">
                angle {gradient.angleDeg ?? 180}°
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={gradient.angleDeg ?? 180}
                  onChange={(e) =>
                    setStyle({ fill: { kind: "linear-gradient", stops, angleDeg: Number(e.target.value) } }, { coalesceMs: 200 })
                  }
                />
              </label>
            )}
          </div>

          <div className="flex flex-col gap-1 border-t border-border pt-2">
            <span className="text-muted">effects</span>
            {EFFECTS.map((c) => {
              const on = layers.find((l) => l.kind === c.kind);
              return (
                <div key={c.kind} className="flex flex-wrap items-center gap-2">
                  <label className="flex w-24 items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={!!on}
                      onChange={(e) =>
                        setLayer(c.kind, e.target.checked ? { kind: c.kind, color: c.color, size: c.size } : null)
                      }
                    />
                    {c.label}
                  </label>
                  {on && (
                    <>
                      <input
                        type="color"
                        aria-label={`${c.label} colour`}
                        value={on.color ?? c.color}
                        onChange={(e) => setLayer(c.kind, { ...on, color: e.target.value.toUpperCase() })}
                        className="h-6 w-8 rounded border border-border bg-surface"
                      />
                      <input
                        type="range"
                        aria-label={`${c.label} size`}
                        min={1}
                        max={c.max}
                        step={1}
                        value={on.size ?? c.size}
                        onChange={(e) => setLayer(c.kind, { ...on, size: Number(e.target.value) })}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </details>
    </div>
  );
});
