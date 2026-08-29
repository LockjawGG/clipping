"use client";

import { memo, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import {
  CAPTION_TEMPLATES,
  CAPTION_TEMPLATE_CATEGORIES,
  type CaptionTemplate,
  type CaptionTemplateCategory,
} from "@/lib/captions/preset-library.ts";
import { resolveTextStyle, textStyleToCss } from "@/lib/captions/text-style.ts";

type BrowserCategory = CaptionTemplateCategory | "mine";

/** Fields that live in the scalar SubtitleConfig columns (vs the styleJson blob). */
export const SCALAR_STYLE_KEYS = [
  "fontFamily",
  "fontWeight",
  "fontSizePx",
  "textColor",
  "highlightColor",
  "outlineColor",
  "outlineWidthPx",
  "backgroundColor",
  "alignment",
  "positionY",
  "uppercase",
] as const;

const RICH_STYLE_KEYS = [
  "fill",
  "layers",
  "letterSpacingEm",
  "lineHeight",
  "textTransform",
  "glass",
] as const;

export interface SplitTemplateStyle {
  scalar: Record<string, unknown>;
  /** JSON string of the rich extras, or null when the template is scalar-only. */
  styleJson: string | null;
  wordRulesJson: string | null;
}

/** Split a template into the scalar patch + the styleJson / wordRulesJson blobs. */
export function splitTemplate(t: CaptionTemplate): SplitTemplateStyle {
  const style = t.style as Record<string, unknown>;
  const scalar: Record<string, unknown> = {};
  for (const k of SCALAR_STYLE_KEYS) if (k in style) scalar[k] = style[k];
  // A template that doesn't set a box means "no box" — make that explicit so
  // applying it clears a box left over from a previous template.
  if (!("backgroundColor" in scalar)) scalar.backgroundColor = null;
  const rich: Record<string, unknown> = {};
  for (const k of RICH_STYLE_KEYS) if (k in style) rich[k] = style[k];
  return {
    scalar,
    styleJson: Object.keys(rich).length ? JSON.stringify(rich) : null,
    wordRulesJson: t.wordRules && t.wordRules.length ? JSON.stringify(t.wordRules) : null,
  };
}

const SAMPLE = "Your caption";
const CARD_W = 172;
const CARD_H = 108;
const NAME_H = 22;
const PREVIEW_PAD = 10;
/** Every card renders its sample at this on-card size, regardless of the
 *  template's real `fontSizePx`, so the grid reads evenly. */
const PREVIEW_FONT_PX = 16;

/** A live mini-preview of a template, rendered through the same CSS as the burn. */
const TemplateCard = memo(function TemplateCard({
  template,
  active,
  onApply,
}: {
  template: CaptionTemplate;
  active: boolean;
  onApply: () => void;
}) {
  const { text, panel } = useMemo(() => {
    const resolved = resolveTextStyle(template.style);
    // Normalise to PREVIEW_FONT_PX: the card demonstrates the *look* (font,
    // colour, stroke, glow, gradient, box) — not the template's scale.
    const scale = PREVIEW_FONT_PX / Math.max(1, resolved.fontSizePx);
    return textStyleToCss(resolved, { scale });
  }, [template]);

  return (
    <button
      type="button"
      onClick={onApply}
      aria-pressed={active}
      title={`${template.name} — apply`}
      className="flex shrink-0 flex-col overflow-hidden rounded-lg border-2 transition-colors"
      style={{
        width: CARD_W,
        height: CARD_H,
        background: "#0d0d10",
        borderColor: active ? "rgb(var(--c-accent))" : "rgb(var(--c-border))",
      }}
    >
      {/* preview: fixed box, equal padding, text centred and clipped */}
      <span
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ padding: PREVIEW_PAD }}
      >
        <span style={(panel ?? undefined) as unknown as CSSProperties | undefined}>
          <span
            style={{
              ...(text as unknown as CSSProperties),
              display: "inline-block",
              lineHeight: 1.15,
              maxWidth: "100%",
              maxHeight: `${PREVIEW_FONT_PX * 1.15 * 2}px`,
              overflow: "hidden",
              whiteSpace: "normal",
              wordBreak: "break-word",
            }}
          >
            {SAMPLE}
          </span>
        </span>
      </span>
      {/* name: fixed-height row, always in the same place */}
      <span
        className="w-full shrink-0 truncate border-t border-white/10 bg-black/40 px-2 text-center text-[10px] font-medium leading-none text-white/85"
        style={{ height: NAME_H, lineHeight: `${NAME_H}px` }}
      >
        {template.name}
      </span>
    </button>
  );
});

interface SavedPreset {
  id: string;
  name: string;
  style: string;
  animation: string;
  wordRules: string | null;
}

/** The "Mine" tab — the user's saved styles, fetched live. */
const MyTemplates = memo(function MyTemplates({
  disabled,
  activeId,
  savedTick,
  onApply,
}: {
  disabled?: boolean;
  activeId?: string | null;
  savedTick: number;
  onApply: (template: CaptionTemplate) => void;
}) {
  const [rows, setRows] = useState<SavedPreset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    fetch("/api/text-presets?kind=caption")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("could not load your styles"))))
      .then((data: SavedPreset[]) => live && setRows(data))
      .catch((e) => live && setError(e instanceof Error ? e.message : "load failed"));
    return () => {
      live = false;
    };
  }, [savedTick]);

  const templates = useMemo<CaptionTemplate[]>(() => {
    if (!rows) return [];
    return rows.map((r) => {
      let style: CaptionTemplate["style"] = {};
      let wordRules: CaptionTemplate["wordRules"];
      try {
        style = JSON.parse(r.style);
      } catch {
        /* keep {} */
      }
      if (r.wordRules) {
        try {
          wordRules = JSON.parse(r.wordRules);
        } catch {
          /* skip */
        }
      }
      return {
        id: r.id,
        category: "clean",
        name: r.name,
        style,
        animation: r.animation,
        wordRules,
      } as CaptionTemplate;
    });
  }, [rows]);

  async function remove(id: string) {
    setRows((cur) => cur?.filter((r) => r.id !== id) ?? cur);
    await fetch(`/api/text-presets/${id}`, { method: "DELETE" }).catch(() => {});
  }

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!rows) return <p className="text-xs text-muted">Loading…</p>;
  if (rows.length === 0)
    return (
      <p className="text-xs text-muted">
        No saved styles yet — tune a caption and hit “Save as template”.
      </p>
    );

  return (
    <div
      className={`flex gap-2 overflow-x-auto pb-1 ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      {templates.map((t) => (
        <div key={t.id} className="relative shrink-0">
          <TemplateCard template={t} active={activeId === t.id} onApply={() => onApply(t)} />
          <button
            type="button"
            aria-label={`Delete ${t.name}`}
            onClick={() => remove(t.id)}
            className="absolute right-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white/90 hover:bg-danger"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
});

interface Props {
  disabled?: boolean;
  /** id of the currently-applied template, if known. */
  activeId?: string | null;
  /** Bumped by the parent after a "Save as template" so "Mine" refetches. */
  savedTick?: number;
  onApply: (template: CaptionTemplate) => void;
}

export const TemplateBrowser = memo(function TemplateBrowser({
  disabled,
  activeId,
  savedTick = 0,
  onApply,
}: Props) {
  const [category, setCategory] = useState<BrowserCategory>("clean");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const list = useMemo(() => {
    if (q) {
      return CAPTION_TEMPLATES.filter(
        (t) => t.name.toLowerCase().includes(q) || t.category.includes(q),
      );
    }
    return category === "mine" ? [] : CAPTION_TEMPLATES.filter((t) => t.category === category);
  }, [q, category]);

  const blurb = q
    ? `${list.length} match${list.length === 1 ? "" : "es"}`
    : category === "mine"
      ? "Your saved styles"
      : CAPTION_TEMPLATE_CATEGORIES.find((c) => c.id === category)?.blurb;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3" aria-disabled={disabled}>
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-xs font-medium text-muted">Templates</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search styles…"
          aria-label="Search templates"
          className="field w-32 py-0.5 text-xs sm:w-44"
        />
        {blurb && <span className="hidden flex-1 text-right text-[11px] text-muted md:inline">{blurb}</span>}
      </div>

      {!q && (
        <div className="seg flex-wrap self-start" role="tablist" aria-label="Template category">
          {CAPTION_TEMPLATE_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={category === c.id}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={category === "mine"}
            onClick={() => setCategory("mine")}
          >
            Mine
          </button>
        </div>
      )}

      {!q && category === "mine" ? (
        <MyTemplates
          disabled={disabled}
          activeId={activeId}
          savedTick={savedTick}
          onApply={onApply}
        />
      ) : q && list.length === 0 ? (
        <p className="text-xs text-muted">No styles match “{query.trim()}”.</p>
      ) : (
        <div
          className={`flex gap-2 overflow-x-auto pb-1 ${disabled ? "pointer-events-none opacity-50" : ""}`}
        >
          {list.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              active={activeId === t.id}
              onApply={() => onApply(t)}
            />
          ))}
        </div>
      )}
    </div>
  );
});
