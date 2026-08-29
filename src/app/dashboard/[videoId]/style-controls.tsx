"use client";

import { memo } from "react";

import type { EffectLayer, EffectLayerKind, Fill, TextStyle } from "@/lib/captions/text-style.ts";
import { DEFAULT_TEXT_STYLE } from "@/lib/captions/text-style.ts";
import type { WordRule, WordRuleEffect, WordRuleTrigger } from "@/lib/captions/word-rules.ts";

/**
 * The one caption/text style panel, shared by transcribed subtitles
 * (`CaptionControls`) and inserted text captions (`TextOverlayInspector`).
 *
 * It operates on a plain `Partial<TextStyle>` plus `WordRule[]` — the same
 * shapes the render engine (`textStyleToCss`, `applyWordRules`) consumes — so
 * every control here works identically for both, and any future style field or
 * template automatically applies to both.
 */

export const FONTS = ["Inter", "Archivo Black", "Georgia", "Impact", "JetBrains Mono"] as const;
const WEIGHTS = [400, 600, 700, 800, 900] as const;
const CASES = ["none", "uppercase", "lowercase", "capitalize"] as const;

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

const D = DEFAULT_TEXT_STYLE;
const swatch = "h-7 w-9 rounded border border-border bg-surface";

// ---------------------------------------------------------------- word rules

const TRIGGERS: { id: WordRuleTrigger; label: string }[] = [
  { id: "active", label: "while spoken" },
  { id: "spoken", label: "once spoken" },
  { id: "emphasis", label: "when emphatic" },
  { id: "always", label: "always" },
];

const QUICK_RULES: { label: string; rules: WordRule[] }[] = [
  { label: "Karaoke", rules: [{ trigger: "spoken", effect: { color: "#22FF88" } }] },
  { label: "Active pop", rules: [{ trigger: "active", effect: { color: "#FFE600", scale: 1.1 } }] },
  {
    label: "AI emphasis",
    rules: [
      { trigger: "active", effect: { color: "#FFE600" } },
      { trigger: "emphasis", effect: { scale: 1.2, bold: true, background: "#7C3AED" } },
    ],
  },
];

export const WordRuleEditor = memo(function WordRuleEditor({
  rules,
  onChange,
}: {
  rules: WordRule[];
  onChange: (rules: WordRule[]) => void;
}) {
  const setRule = (i: number, patch: Partial<WordRule>) =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setEffect = (i: number, patch: Partial<WordRuleEffect>) =>
    setRule(i, { effect: { ...rules[i].effect, ...patch } });

  return (
    <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
      <summary className="cursor-pointer text-muted">Word emphasis rules</summary>
      <div className="flex flex-col gap-2 pt-2">
        <div className="flex flex-wrap gap-1.5">
          {QUICK_RULES.map((q) => (
            <button
              key={q.label}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onChange(q.rules)}
            >
              {q.label}
            </button>
          ))}
          {rules.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>

        {rules.length === 0 && (
          <p className="text-[11px] text-muted">
            No rules — every word uses the base style. &ldquo;Emphatic&rdquo; words are the loud ones
            the transcription flags.
          </p>
        )}

        {rules.map((r, i) => {
          const e = r.effect;
          return (
            <div
              key={i}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-2"
            >
              <select
                value={r.trigger}
                onChange={(ev) => setRule(i, { trigger: ev.target.value as WordRuleTrigger })}
                className="field py-0.5"
              >
                {TRIGGERS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>

              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={e.color !== undefined}
                  onChange={(ev) => setEffect(i, { color: ev.target.checked ? "#FFE600" : undefined })}
                />
                colour
              </label>
              {e.color !== undefined && (
                <input
                  type="color"
                  aria-label="rule colour"
                  value={e.color}
                  onChange={(ev) => setEffect(i, { color: ev.target.value.toUpperCase() })}
                  className="h-6 w-8 rounded border border-border bg-surface"
                />
              )}

              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={e.background !== undefined}
                  onChange={(ev) =>
                    setEffect(i, { background: ev.target.checked ? "#7C3AED" : undefined })
                  }
                />
                box
              </label>
              {e.background !== undefined && (
                <input
                  type="color"
                  aria-label="rule box colour"
                  value={e.background}
                  onChange={(ev) => setEffect(i, { background: ev.target.value.toUpperCase() })}
                  className="h-6 w-8 rounded border border-border bg-surface"
                />
              )}

              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={e.scale !== undefined}
                  onChange={(ev) => setEffect(i, { scale: ev.target.checked ? 1.12 : undefined })}
                />
                size
              </label>
              {e.scale !== undefined && (
                <input
                  type="range"
                  aria-label="rule size"
                  min={1}
                  max={1.6}
                  step={0.02}
                  value={e.scale}
                  onChange={(ev) => setEffect(i, { scale: Number(ev.target.value) })}
                />
              )}

              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!!e.bold}
                  onChange={(ev) => setEffect(i, { bold: ev.target.checked || undefined })}
                />
                bold
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!!e.underline}
                  onChange={(ev) => setEffect(i, { underline: ev.target.checked || undefined })}
                />
                underline
              </label>

              <button
                type="button"
                onClick={() => onChange(rules.filter((_, j) => j !== i))}
                aria-label="remove rule"
                className="ml-auto text-muted hover:text-danger"
              >
                ✕
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => onChange([...rules, { trigger: "active", effect: { color: "#FFE600" } }])}
          className="btn btn-sm self-start"
        >
          + Add rule
        </button>
      </div>
    </details>
  );
});

// ---------------------------------------------------------------- style panel

export interface StyleControlsProps {
  style: Partial<TextStyle>;
  onStyle: (patch: Partial<TextStyle>, opts?: { coalesceMs?: number }) => void;
  /** Omit both to hide the word-rules section (e.g. for a static text block). */
  wordRules?: WordRule[];
  onWordRules?: (rules: WordRule[]) => void;
  disabled?: boolean;
}

export const StyleControls = memo(function StyleControls({
  style,
  onStyle,
  wordRules,
  onWordRules,
  disabled,
}: StyleControlsProps) {
  const s = style;
  const layers = s.layers ?? [];
  const setLayer = (kind: EffectLayerKind, next: EffectLayer | null) => {
    const merged = [...layers.filter((l) => l.kind !== kind), ...(next ? [next] : [])];
    merged.sort(
      (a, b) =>
        EFFECT_CATALOG.findIndex((c) => c.kind === a.kind) -
        EFFECT_CATALOG.findIndex((c) => c.kind === b.kind),
    );
    onStyle({ layers: merged });
  };
  const gradient = s.fill?.kind === "linear-gradient" ? s.fill : null;
  const stops = gradient?.stops ?? ["#FFD166", "#EF476F"];
  const setFill = (fill: Fill) => onStyle({ fill });

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-3 disabled:opacity-50">
      {/* typography */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">font</span>
          <select
            value={s.fontFamily ?? D.fontFamily}
            onChange={(e) => onStyle({ fontFamily: e.target.value })}
            className="field py-1"
          >
            {FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">weight</span>
          <select
            value={s.fontWeight ?? D.fontWeight}
            onChange={(e) => onStyle({ fontWeight: Number(e.target.value) })}
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
          <span className="text-xs text-muted">size · {s.fontSizePx ?? D.fontSizePx}px</span>
          <input
            type="range"
            min={16}
            max={200}
            step={2}
            value={s.fontSizePx ?? D.fontSizePx}
            onChange={(e) => onStyle({ fontSizePx: Number(e.target.value) }, { coalesceMs: 150 })}
          />
        </label>
      </div>

      {/* colour + stroke */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5">
          text
          <input
            type="color"
            value={s.textColor ?? D.textColor}
            onChange={(e) => onStyle({ textColor: e.target.value.toUpperCase() })}
            className={swatch}
          />
        </label>
        <label className="flex items-center gap-1.5">
          highlight
          <input
            type="color"
            value={s.highlightColor ?? D.highlightColor}
            onChange={(e) => onStyle({ highlightColor: e.target.value.toUpperCase() })}
            className={swatch}
          />
        </label>
        <label className="flex items-center gap-1.5">
          outline
          <input
            type="color"
            value={s.outlineColor ?? D.outlineColor}
            onChange={(e) => onStyle({ outlineColor: e.target.value.toUpperCase() })}
            className={swatch}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-xs text-muted">outline {s.outlineWidthPx ?? D.outlineWidthPx}</span>
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={s.outlineWidthPx ?? D.outlineWidthPx}
            onChange={(e) => onStyle({ outlineWidthPx: Number(e.target.value) }, { coalesceMs: 150 })}
          />
        </label>
      </div>

      {/* box / uppercase / align */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={s.backgroundColor != null}
            onChange={(e) => onStyle({ backgroundColor: e.target.checked ? "#000000" : null })}
          />
          background box
        </label>
        {s.backgroundColor != null && (
          <input
            type="color"
            value={s.backgroundColor}
            onChange={(e) => onStyle({ backgroundColor: e.target.value.toUpperCase() })}
            className={swatch}
          />
        )}
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={!!s.uppercase}
            onChange={(e) => onStyle({ uppercase: e.target.checked })}
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
                aria-pressed={(s.alignment ?? D.alignment) === a}
                onClick={() => onStyle({ alignment: a })}
              >
                {a}
              </button>
            ))}
          </span>
        </span>
      </div>

      {/* fills & effects */}
      <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
        <summary className="cursor-pointer text-muted">Fills &amp; effects</summary>
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2">
              spacing {(s.letterSpacingEm ?? 0).toFixed(2)}em
              <input
                type="range"
                min={-0.05}
                max={0.4}
                step={0.01}
                value={s.letterSpacingEm ?? 0}
                onChange={(e) =>
                  onStyle({ letterSpacingEm: Number(e.target.value) }, { coalesceMs: 150 })
                }
              />
            </label>
            <label className="flex items-center gap-2">
              line {(s.lineHeight ?? D.lineHeight).toFixed(2)}
              <input
                type="range"
                min={0.9}
                max={1.8}
                step={0.05}
                value={s.lineHeight ?? D.lineHeight}
                onChange={(e) => onStyle({ lineHeight: Number(e.target.value) }, { coalesceMs: 150 })}
              />
            </label>
            <label className="flex items-center gap-1.5">
              case
              <select
                value={s.textTransform ?? "none"}
                onChange={(e) =>
                  onStyle({ textTransform: e.target.value as TextStyle["textTransform"] })
                }
                className="field py-0.5"
              >
                {CASES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!!s.glass}
                onChange={(e) => onStyle({ glass: e.target.checked })}
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
                    setFill(
                      k === "gradient"
                        ? { kind: "linear-gradient", stops, angleDeg: gradient?.angleDeg ?? 180 }
                        : { kind: "solid" },
                    )
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
                      setFill({ kind: "linear-gradient", stops: next, angleDeg: gradient.angleDeg ?? 180 });
                    }}
                    className={swatch}
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
                      setFill({ kind: "linear-gradient", stops, angleDeg: Number(e.target.value) })
                    }
                  />
                </label>
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-2">
            <span className="text-muted">effects</span>
            {EFFECT_CATALOG.map((c) => {
              const on = layers.find((l) => l.kind === c.kind);
              return (
                <div key={c.kind} className="flex flex-wrap items-center gap-2">
                  <label className="flex w-28 items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={!!on}
                      onChange={(e) =>
                        setLayer(
                          c.kind,
                          e.target.checked ? { kind: c.kind, color: c.color, size: c.size } : null,
                        )
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

      {/* word rules */}
      {wordRules && onWordRules && <WordRuleEditor rules={wordRules} onChange={onWordRules} />}
    </fieldset>
  );
});
