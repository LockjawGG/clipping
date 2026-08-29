"use client";

import { memo, useMemo } from "react";

import type { EffectLayer, EffectLayerKind } from "@/lib/captions/text-style.ts";
import { parseRich, serializeRich, type RichExtras } from "@/lib/captions/rich-extras.ts";

export type { RichExtras };
export { parseRich, serializeRich };

/** Effects offered in the picker (outline lives in the scalar controls). */
const EFFECT_CATALOG: {
  kind: EffectLayerKind;
  label: string;
  color: string;
  size: number;
  max: number;
}[] = [
  { kind: "glow", label: "Glow", color: "#8AB4FF", size: 14, max: 40 },
  { kind: "neon", label: "Neon", color: "#00E5FF", size: 9, max: 24 },
  { kind: "shadow-soft", label: "Soft shadow", color: "#000000", size: 12, max: 40 },
  { kind: "shadow-hard", label: "Hard shadow", color: "#000000", size: 6, max: 24 },
  { kind: "shadow-long", label: "Long shadow", color: "#1A1A1A", size: 12, max: 24 },
  { kind: "emboss", label: "Emboss", color: "#000000", size: 4, max: 12 },
];

interface Props {
  styleJson: string | null;
  onChange: (styleJson: string | null) => void;
}

export const CaptionStyleAdvanced = memo(function CaptionStyleAdvanced({ styleJson, onChange }: Props) {
  const rich = useMemo(() => parseRich(styleJson), [styleJson]);
  const patch = (p: Partial<RichExtras>) => onChange(serializeRich({ ...rich, ...p }));

  const layers = rich.layers ?? [];
  const layerFor = (kind: EffectLayerKind) => layers.find((l) => l.kind === kind);

  const setLayer = (kind: EffectLayerKind, next: EffectLayer | null) => {
    const kept = layers.filter((l) => l.kind !== kind);
    const merged = next ? [...kept, next] : kept;
    // keep catalog order so the shadow stack is deterministic
    merged.sort(
      (a, b) =>
        EFFECT_CATALOG.findIndex((c) => c.kind === a.kind) -
        EFFECT_CATALOG.findIndex((c) => c.kind === b.kind),
    );
    patch({ layers: merged });
  };

  const gradient = rich.fill?.kind === "linear-gradient" ? rich.fill : null;
  const stops = gradient?.stops ?? ["#FFD166", "#EF476F"];

  return (
    <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
      <summary className="cursor-pointer text-muted">Advanced style — fills &amp; effects</summary>
      <div className="flex flex-col gap-3 pt-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2">
            spacing {(rich.letterSpacingEm ?? 0).toFixed(2)}em
            <input
              type="range"
              min={-0.05}
              max={0.4}
              step={0.01}
              value={rich.letterSpacingEm ?? 0}
              onChange={(e) => patch({ letterSpacingEm: Number(e.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2">
            line {(rich.lineHeight ?? 1.15).toFixed(2)}
            <input
              type="range"
              min={0.9}
              max={1.8}
              step={0.05}
              value={rich.lineHeight ?? 1.15}
              onChange={(e) => patch({ lineHeight: Number(e.target.value) })}
            />
          </label>
          <label className="flex items-center gap-1.5">
            case
            <select
              value={rich.textTransform ?? "none"}
              onChange={(e) => patch({ textTransform: e.target.value as RichExtras["textTransform"] })}
              className="field py-0.5"
            >
              {(["none", "uppercase", "lowercase", "capitalize"] as const).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={!!rich.glass}
              onChange={(e) => patch({ glass: e.target.checked })}
            />
            frosted glass
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-2">
          <span className="text-muted">fill</span>
          <span className="seg">
            {(["solid", "gradient"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={(k === "gradient") === !!gradient}
                onClick={() =>
                  patch({
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
          {gradient && (
            <>
              {stops.map((c, i) => (
                <input
                  key={i}
                  type="color"
                  aria-label={`gradient colour ${i + 1}`}
                  value={c}
                  onChange={(e) => {
                    const next = [...stops];
                    next[i] = e.target.value.toUpperCase();
                    patch({ fill: { kind: "linear-gradient", stops: next, angleDeg: gradient.angleDeg ?? 180 } });
                  }}
                  className="h-7 w-9 rounded border border-border bg-surface"
                />
              ))}
              <label className="flex items-center gap-2">
                angle {gradient.angleDeg ?? 180}°
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={gradient.angleDeg ?? 180}
                  onChange={(e) =>
                    patch({ fill: { kind: "linear-gradient", stops, angleDeg: Number(e.target.value) } })
                  }
                />
              </label>
            </>
          )}
        </div>

        <div className="flex flex-col gap-1.5 border-t border-border pt-2">
          <span className="text-muted">effects</span>
          {EFFECT_CATALOG.map((c) => {
            const on = layerFor(c.kind);
            return (
              <div key={c.kind} className="flex flex-wrap items-center gap-2">
                <label className="flex w-28 items-center gap-1.5">
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
                      className="h-7 w-9 rounded border border-border bg-surface"
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
                    <span className="w-6 text-right text-muted">{on.size ?? c.size}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-[11px] text-muted">
          Gradient, glow, neon, long shadow, emboss and glass render with the animation engine
          (a little slower than a plain burn).
        </p>
      </div>
    </details>
  );
});
