"use client";

import { memo } from "react";

import type { AnimEase } from "@/lib/captions/anim-spec.ts";
import type { ElementAnimSpec, MotionKeyframe } from "@/lib/captions/element-anim.ts";
import {
  ELEMENT_INTRO_OPTIONS,
  ELEMENT_LOOP_OPTIONS,
  ELEMENT_OUTRO_OPTIONS,
  MOTION_EASES,
  MOTION_LIMITS,
} from "@/lib/captions/element-anim.ts";

/**
 * The one motion panel, shared by every animatable element — inserted text
 * captions today, images / GIFs and sequence items as they gain motion.
 *
 * It operates on a plain `ElementAnimSpec`, the same shape the render engine
 * (`sampleElementAnim`) consumes, so every control here works identically
 * wherever it is mounted and any future preset appears in all of them at once.
 */

const L = MOTION_LIMITS;

/** Keyframable properties, with the units and ranges the editor exposes. */
type KfField = Exclude<keyof MotionKeyframe, "atMs" | "ease">;

const KF_FIELDS: {
  key: KfField;
  label: string;
  min: number;
  max: number;
  step: number;
  identity: number;
}[] = [
  { key: "x", label: "x", min: -600, max: 600, step: 1, identity: 0 },
  { key: "y", label: "y", min: -600, max: 600, step: 1, identity: 0 },
  { key: "scale", label: "scale", min: 0, max: 4, step: 0.05, identity: 1 },
  { key: "rotate", label: "turn", min: -360, max: 360, step: 1, identity: 0 },
  { key: "opacity", label: "fade", min: 0, max: 1, step: 0.05, identity: 1 },
];

interface KeyframeEditorProps {
  keyframes: MotionKeyframe[];
  onChange: (next: MotionKeyframe[]) => void;
}

const KeyframeEditor = memo(function KeyframeEditor({ keyframes, onChange }: KeyframeEditorProps) {
  const patch = (i: number, p: Partial<MotionKeyframe>) =>
    onChange(keyframes.map((k, j) => (j === i ? { ...k, ...p } : k)));

  const toggleField = (i: number, key: KfField, identity: number) => {
    const next = { ...keyframes[i] };
    if (next[key] === undefined) next[key] = identity;
    else delete next[key];
    onChange(keyframes.map((x, j) => (j === i ? next : x)));
  };

  const add = () => {
    // New keyframes land after the last one so the list stays chronological.
    const atMs = keyframes.length ? keyframes[keyframes.length - 1].atMs + 500 : 0;
    onChange([...keyframes, { atMs, x: 0 }]);
  };

  return (
    <div className="flex flex-col gap-2">
      {keyframes.length === 0 && (
        <p className="text-[11px] text-muted">
          No keyframes. Presets above handle most motion — add keyframes only for a path they cannot
          express.
        </p>
      )}

      {keyframes.map((k, i) => (
        <div
          key={i}
          className="flex flex-col gap-1.5 rounded border border-border bg-surface px-2 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex items-center gap-1">
              at
              <input
                type="number"
                min={0}
                step={50}
                value={k.atMs}
                onChange={(e) => patch(i, { atMs: Math.max(0, Number(e.target.value) || 0) })}
                className="field w-20 py-0.5"
                aria-label={`Keyframe ${i + 1} time in ms`}
              />
              ms
            </label>
            <label className="flex items-center gap-1">
              ease
              <select
                value={k.ease ?? "inOut"}
                onChange={(e) => patch(i, { ease: e.target.value as AnimEase })}
                className="field py-0.5"
                aria-label={`Keyframe ${i + 1} easing`}
              >
                {MOTION_EASES.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => onChange(keyframes.filter((_, j) => j !== i))}
              className="btn btn-danger btn-sm ml-auto"
            >
              Remove
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {KF_FIELDS.map((f) => {
              const on = k[f.key] !== undefined;
              return (
                <span key={f.key} className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleField(i, f.key, f.identity)}
                    className={on ? "chip bg-accent text-accent-fg" : "chip"}
                    title={
                      on
                        ? `Stop animating ${f.label} at this keyframe`
                        : `Animate ${f.label} at this keyframe`
                    }
                  >
                    {f.label}
                  </button>
                  {on && (
                    <input
                      type="number"
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      value={k[f.key] as number}
                      onChange={(e) => patch(i, { [f.key]: Number(e.target.value) })}
                      className="field w-16 py-0.5"
                      aria-label={`Keyframe ${i + 1} ${f.label}`}
                    />
                  )}
                </span>
              );
            })}
          </div>
        </div>
      ))}

      <button type="button" onClick={add} className="btn btn-ghost btn-sm self-start">
        + Add keyframe
      </button>
    </div>
  );
});

interface Props {
  anim: ElementAnimSpec;
  onAnim: (patch: Partial<ElementAnimSpec>, opts?: { coalesceMs?: number }) => void;
  /** Shown when the element has no end time, so an outro can never fire. */
  canOutro?: boolean;
}

export const MotionControls = memo(function MotionControls({ anim, onAnim, canOutro = true }: Props) {
  const intensity = anim.intensity ?? L.intensity.default;
  const speed = anim.loopSpeed ?? L.speed.default;
  const tuned =
    anim.intensity !== undefined ||
    anim.loopSpeed !== undefined ||
    anim.delayMs !== undefined ||
    anim.introMs !== undefined ||
    anim.outroMs !== undefined ||
    anim.ease !== undefined;
  const kfCount = anim.keyframes?.length ?? 0;

  return (
    <div className="flex flex-col gap-2">
      {/* preset row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1">
          in
          <select
            value={anim.intro ?? "none"}
            onChange={(e) => onAnim({ intro: e.target.value })}
            className="field py-0.5"
          >
            {ELEMENT_INTRO_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          loop
          <select
            value={anim.loop ?? "none"}
            onChange={(e) => onAnim({ loop: e.target.value })}
            className="field py-0.5"
          >
            {ELEMENT_LOOP_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          out
          <select
            value={anim.outro ?? "none"}
            onChange={(e) => onAnim({ outro: e.target.value })}
            className="field py-0.5"
          >
            {ELEMENT_OUTRO_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {!canOutro && anim.outro && anim.outro !== "none" && (
          <span className="text-[10px] text-danger">
            set an end time for this layer or the out animation never plays
          </span>
        )}
      </div>

      <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
        <summary className="cursor-pointer text-muted">
          Timing &amp; feel{tuned ? " · tuned" : ""}
        </summary>
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2">
              intensity {intensity.toFixed(2)}×
              <input
                type="range"
                min={L.intensity.min}
                max={L.intensity.max}
                step={L.intensity.step}
                value={intensity}
                onChange={(e) => onAnim({ intensity: Number(e.target.value) }, { coalesceMs: 150 })}
              />
            </label>
            <label className="flex items-center gap-2">
              loop speed {speed.toFixed(1)}×
              <input
                type="range"
                min={L.speed.min}
                max={L.speed.max}
                step={L.speed.step}
                value={speed}
                onChange={(e) => onAnim({ loopSpeed: Number(e.target.value) }, { coalesceMs: 150 })}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1">
              delay
              <input
                type="number"
                min={L.delayMs.min}
                max={L.delayMs.max}
                step={L.delayMs.step}
                value={anim.delayMs ?? 0}
                onChange={(e) => onAnim({ delayMs: Number(e.target.value) || 0 })}
                className="field w-20 py-0.5"
              />
              ms
            </label>
            <label className="flex items-center gap-1">
              in for
              <input
                type="number"
                min={L.durationMs.min}
                max={L.durationMs.max}
                step={L.durationMs.step}
                value={anim.introMs ?? ""}
                placeholder="auto"
                onChange={(e) =>
                  onAnim({ introMs: e.target.value === "" ? undefined : Number(e.target.value) })
                }
                className="field w-20 py-0.5"
              />
              ms
            </label>
            <label className="flex items-center gap-1">
              out for
              <input
                type="number"
                min={L.durationMs.min}
                max={L.durationMs.max}
                step={L.durationMs.step}
                value={anim.outroMs ?? ""}
                placeholder="auto"
                onChange={(e) =>
                  onAnim({ outroMs: e.target.value === "" ? undefined : Number(e.target.value) })
                }
                className="field w-20 py-0.5"
              />
              ms
            </label>
            <label className="flex items-center gap-1">
              easing
              <select
                value={anim.ease ?? ""}
                onChange={(e) =>
                  onAnim({ ease: e.target.value === "" ? undefined : (e.target.value as AnimEase) })
                }
                className="field py-0.5"
              >
                <option value="">preset</option>
                {MOTION_EASES.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {tuned && (
            <button
              type="button"
              className="btn btn-ghost btn-sm self-start"
              onClick={() =>
                onAnim({
                  intensity: undefined,
                  loopSpeed: undefined,
                  delayMs: undefined,
                  introMs: undefined,
                  outroMs: undefined,
                  ease: undefined,
                })
              }
            >
              Reset timing
            </button>
          )}
        </div>
      </details>

      <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
        <summary className="cursor-pointer text-muted">
          Keyframes{kfCount ? ` · ${kfCount}` : ""}
        </summary>
        <div className="pt-2">
          <KeyframeEditor
            keyframes={anim.keyframes ?? []}
            onChange={(keyframes) => onAnim({ keyframes: keyframes.length ? keyframes : undefined })}
          />
        </div>
      </details>
    </div>
  );
});
