/**
 * Word-level caption rules — karaoke, active-speaker highlight, and AI emphasis.
 *
 * A rule fires on a trigger (a word being spoken / currently active / emphatic)
 * and applies a small style delta. This is separate from the animation spec:
 * animations move pixels, word rules recolour/scale/box individual words.
 *
 * Emphasis is derived from signals the transcription pipeline already produces
 * (relative loudness, model confidence) — no new data model.
 */

export type WordRuleTrigger = "spoken" | "active" | "emphasis" | "always";

export interface WordRuleEffect {
  color?: string;
  /** Multiplies the base font size. */
  scale?: number;
  bold?: boolean;
  underline?: boolean;
  /** Highlight box behind the word. */
  background?: string;
}

export interface WordRule {
  trigger: WordRuleTrigger;
  effect: WordRuleEffect;
}

export interface WordRuleContext {
  spoken: boolean;
  active: boolean;
  /** 0..1 model confidence for the word, when known. */
  confidence?: number;
  /** 0..1 loudness of the word relative to its cue, when known. */
  loudness?: number;
}

/** A word this loud (relative to its cue) reads as emphasised. */
export const EMPHASIS_LOUDNESS_MIN = 0.72;
/** Very low confidence on a loud word is a strong "they shouted this" signal. */
export const EMPHASIS_CONFIDENCE_MAX = 0.5;

export function isEmphasis(ctx: WordRuleContext): boolean {
  if (!ctx.spoken) return false;
  const loud = ctx.loudness ?? 0;
  if (loud >= EMPHASIS_LOUDNESS_MIN) return true;
  if (ctx.confidence !== undefined && ctx.confidence <= EMPHASIS_CONFIDENCE_MAX && loud >= 0.5) {
    return true;
  }
  return false;
}

export function triggerMatches(trigger: WordRuleTrigger, ctx: WordRuleContext): boolean {
  switch (trigger) {
    case "always":
      return true;
    case "spoken":
      return ctx.spoken;
    case "active":
      return ctx.active;
    case "emphasis":
      return isEmphasis(ctx);
  }
}

/**
 * Fold every matching rule into one effect. Rules are applied in order; a later
 * rule overrides an earlier one field-by-field (so put broad rules first,
 * specific ones last).
 */
export function applyWordRules(
  rules: readonly WordRule[] | null | undefined,
  ctx: WordRuleContext,
): WordRuleEffect {
  const out: WordRuleEffect = {};
  if (!rules) return out;
  for (const rule of rules) {
    if (!triggerMatches(rule.trigger, ctx)) continue;
    const e = rule.effect;
    if (e.color !== undefined) out.color = e.color;
    if (e.scale !== undefined) out.scale = e.scale;
    if (e.bold !== undefined) out.bold = e.bold;
    if (e.underline !== undefined) out.underline = e.underline;
    if (e.background !== undefined) out.background = e.background;
  }
  return out;
}

/** A resolved word effect as inline CSS. */
export function wordEffectCss(effect: WordRuleEffect): Record<string, string | number> {
  const css: Record<string, string | number> = {};
  if (effect.color !== undefined) css.color = effect.color;
  if (effect.scale !== undefined && effect.scale !== 1) css.fontSize = `${effect.scale}em`;
  if (effect.bold) css.fontWeight = 800;
  if (effect.underline) css.textDecoration = "underline";
  if (effect.background !== undefined) {
    css.background = effect.background;
    css.padding = "0 0.12em";
    css.borderRadius = "0.08em";
  }
  return css;
}

// ---------- ready-made rule sets ----------

/** Every spoken word stays lit in the highlight colour (classic karaoke). */
export function karaokeRules(color: string): WordRule[] {
  return [{ trigger: "spoken", effect: { color } }];
}

/** Only the word being spoken right now is lit. */
export function activeHighlightRules(color: string): WordRule[] {
  return [{ trigger: "active", effect: { color } }];
}

/** Loud / stressed words get bigger and boxed. */
export function emphasisRules(background: string): WordRule[] {
  return [{ trigger: "emphasis", effect: { scale: 1.14, bold: true, background } }];
}
