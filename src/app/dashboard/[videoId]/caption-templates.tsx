"use client";

import { memo, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import {
  CAPTION_TEMPLATES,
  CAPTION_TEMPLATE_CATEGORIES,
  type CaptionTemplate,
  type CaptionTemplateCategory,
} from "@/lib/captions/preset-library.ts";
import { resolveTextStyle, textStyleToCss } from "@/lib/captions/text-style.ts";

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

const SAMPLE = "your captions here";
const CARD_W = 168;

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
    // Card is ~CARD_W wide against a 1080 frame; shrink px units to match.
    return textStyleToCss(resolved, { scale: CARD_W / 1080 });
  }, [template]);

  return (
    <button
      type="button"
      onClick={onApply}
      aria-pressed={active}
      title={`${template.name} — apply`}
      className="relative flex h-[96px] shrink-0 flex-col items-center justify-center overflow-hidden rounded-lg border-2 px-2 text-center transition-colors"
      style={{
        width: CARD_W,
        background: "#0d0d10",
        borderColor: active ? "rgb(var(--c-accent))" : "rgb(var(--c-border))",
      }}
    >
      <span style={(panel ?? undefined) as unknown as CSSProperties | undefined}>
        <span
          style={{
            ...(text as unknown as CSSProperties),
            display: "inline-block",
            lineHeight: 1.1,
            whiteSpace: "normal",
            wordBreak: "break-word",
          }}
        >
          {SAMPLE}
        </span>
      </span>
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white/85">
        {template.name}
      </span>
    </button>
  );
});

interface Props {
  disabled?: boolean;
  /** id of the currently-applied template, if known. */
  activeId?: string | null;
  onApply: (template: CaptionTemplate) => void;
}

export const TemplateBrowser = memo(function TemplateBrowser({ disabled, activeId, onApply }: Props) {
  const [category, setCategory] = useState<CaptionTemplateCategory>("clean");
  const list = useMemo(() => CAPTION_TEMPLATES.filter((t) => t.category === category), [category]);
  const blurb = CAPTION_TEMPLATE_CATEGORIES.find((c) => c.id === category)?.blurb;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3" aria-disabled={disabled}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">Templates</span>
        {blurb && <span className="hidden text-[11px] text-muted sm:inline">{blurb}</span>}
      </div>

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
      </div>

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
    </div>
  );
});
