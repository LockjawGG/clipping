"use client";

import { memo, useMemo } from "react";

import {
  parseWordRules,
  serializeWordRules,
  type WordRule,
  type WordRuleTrigger,
  type WordRuleEffect,
} from "@/lib/captions/word-rules.ts";

const TRIGGERS: { id: WordRuleTrigger; label: string }[] = [
  { id: "active", label: "while spoken" },
  { id: "spoken", label: "once spoken" },
  { id: "emphasis", label: "when emphatic" },
  { id: "always", label: "always" },
];

const QUICK: { label: string; rules: WordRule[] }[] = [
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

interface Props {
  wordRulesJson: string | null;
  onChange: (json: string | null) => void;
}

export const CaptionWordRules = memo(function CaptionWordRules({ wordRulesJson, onChange }: Props) {
  const rules = useMemo(() => parseWordRules(wordRulesJson), [wordRulesJson]);
  const commit = (next: WordRule[]) => onChange(serializeWordRules(next));

  const setRule = (i: number, patch: Partial<WordRule>) =>
    commit(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setEffect = (i: number, patch: Partial<WordRuleEffect>) =>
    setRule(i, { effect: { ...rules[i].effect, ...patch } });
  const removeRule = (i: number) => commit(rules.filter((_, j) => j !== i));
  const addRule = () => commit([...rules, { trigger: "active", effect: { color: "#FFE600" } }]);

  return (
    <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
      <summary className="cursor-pointer text-muted">Word emphasis rules</summary>
      <div className="flex flex-col gap-2 pt-2">
        <div className="flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q.label}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => commit(q.rules)}
            >
              {q.label}
            </button>
          ))}
          {rules.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => commit([])}>
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
            <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-2">
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
                onClick={() => removeRule(i)}
                aria-label="remove rule"
                className="ml-auto text-muted hover:text-danger"
              >
                ✕
              </button>
            </div>
          );
        })}

        <button type="button" onClick={addRule} className="btn btn-sm self-start">
          + Add rule
        </button>
      </div>
    </details>
  );
});
