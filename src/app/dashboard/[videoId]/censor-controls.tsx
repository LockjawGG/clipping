"use client";

import { memo, useMemo, useState } from "react";

import { audioSpans, detectSpans, type CensorWord } from "@/lib/censor/detect.ts";
import type { AudioCensorMode, CensorWordOverrides } from "@/lib/censor/overrides.ts";
import { CAPTION_CENSOR_MODES, maskWord } from "@/lib/censor/mask.ts";

/**
 * Censor settings for one clip.
 *
 * The panel is built around review, not just configuration: every word the
 * lexicon flags is listed with its timecode and its masked form, and each has a
 * one-click "keep" that adds it to the allow-list. Wrongly bleeping a speaker
 * is a visible, publishable error, so nothing is applied silently — what you
 * see here is exactly what the render will do.
 */

export interface CensorSettings {
  censorEnabled: boolean;
  censorSensitivity: "LOW" | "MEDIUM" | "HIGH";
  censorCaptionMode: "FULL" | "PARTIAL" | "FIRST" | "CUSTOM";
  censorAudioEnabled: boolean;
  censorAudioMode: "MUTE" | "BEEP" | "TONE";
  censorReplacement: string | null;
  censorAllowList: string[];
  censorDenyList: string[];
  /** Per-occurrence overrides, as transcript word ids. */
  censorExemptWordIds: string[];
  censorForceWordIds: string[];
  censorAudioExemptWordIds: string[];
  censorAudioForceWordIds: string[];
  censorWordOverrides: CensorWordOverrides;
}

const SENSITIVITIES: { id: CensorSettings["censorSensitivity"]; label: string; hint: string }[] = [
  { id: "LOW", label: "Low", hint: "the strongest words only" },
  { id: "MEDIUM", label: "Medium", hint: "everyday profanity" },
  { id: "HIGH", label: "High", hint: "adds mild words like damn and hell" },
];

const AUDIO_MODES: { id: CensorSettings["censorAudioMode"]; label: string }[] = [
  { id: "BEEP", label: "Beep (1 kHz)" },
  { id: "TONE", label: "Soft tone (400 Hz)" },
  { id: "MUTE", label: "Silence" },
];

const SOUND_LABEL: Record<AudioCensorMode, string> = {
  BEEP: "beeped",
  TONE: "400 Hz tone",
  MUTE: "silenced",
};

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

interface Props {
  value: CensorSettings;
  /** Clip-relative transcript words, for the live review list. */
  words: CensorWord[];
  onChange: (patch: Partial<CensorSettings>) => void;
}

export const CensorControls = memo(function CensorControls({ value, words, onChange }: Props) {
  const [term, setTerm] = useState("");

  /** The clip's real settings, as the renderer will read them. */
  const liveConfig = useMemo(
    () => ({
      enabled: value.censorEnabled,
      sensitivity: value.censorSensitivity,
      allowList: value.censorAllowList,
      denyList: value.censorDenyList,
      exemptWordIds: value.censorExemptWordIds,
      censorWordIds: value.censorForceWordIds,
      audioEnabled: value.censorAudioEnabled,
      audioExemptWordIds: value.censorAudioExemptWordIds,
      audioForceWordIds: value.censorAudioForceWordIds,
      wordOverrides: value.censorWordOverrides,
    }),
    [value],
  );

  const spans = useMemo(() => {
    // Detection is previewed as if switched on, so the list still shows what
    // *would* be caught while censoring is off. The per-row outcome below is
    // computed from the real config, so nothing here claims an effect the
    // render will not have.
    const preview = detectSpans(words, { ...liveConfig, enabled: true }, 0);
    const seen = new Set(preview.map((sp) => sp.wordId));
    // A word can be bleeped without being masked, and un-masking a word must
    // not drop it from the one screen that exists so nothing is applied
    // silently. Anything the audio will touch is listed too.
    const audioOnly = audioSpans(words, liveConfig, 0).filter((sp) => !seen.has(sp.wordId));
    return [...preview, ...audioOnly].sort((a, b) => a.startMs - b.startMs);
  }, [words, liveConfig]);

  /** Word ids the render will really mask, and really bleep. */
  const outcome = useMemo(() => {
    const masked = new Set(
      detectSpans(words, liveConfig, 0)
        .map((s) => s.wordId)
        .filter(Boolean) as string[],
    );
    const bleeped = new Set(
      audioSpans(words, liveConfig, 0)
        .map((s) => s.wordId)
        .filter(Boolean) as string[],
    );
    return { masked, bleeped };
  }, [words, liveConfig]);

  const soundOf = (wordId: string | undefined): AudioCensorMode =>
    (wordId ? value.censorWordOverrides[wordId]?.audioMode : undefined) ?? value.censorAudioMode;

  /**
   * Stop censoring one occurrence, in every sense.
   *
   * It has to act on both halves at once. A hand-picked word can be marked in
   * the caption list, the audio list, or only one of them, and clearing just
   * the caption list left an audio-only occurrence still bleeping while the
   * button appeared to do nothing — the worst possible outcome for a control
   * whose entire promise is "this one is fine, leave it alone".
   *
   * Everything is dropped from the force lists and added to the exempt lists:
   * exempting an occurrence the rules would not catch anyway costs nothing,
   * and it keeps the decision durable if the sensitivity is raised later.
   */
  const keep = (span: { text: string; wordId?: string; tier: string }) => {
    const id = span.wordId;
    if (!id) return;
    const add = (list: string[]) => (list.includes(id) ? list : [...list, id]);
    onChange({
      censorForceWordIds: value.censorForceWordIds.filter((x) => x !== id),
      censorAudioForceWordIds: value.censorAudioForceWordIds.filter((x) => x !== id),
      censorExemptWordIds: add(value.censorExemptWordIds),
      censorAudioExemptWordIds: add(value.censorAudioExemptWordIds),
    });
  };

  const addDeny = () => {
    const w = term.trim().toLowerCase();
    if (!w || value.censorDenyList.includes(w)) return;
    onChange({ censorDenyList: [...value.censorDenyList, w] });
    setTerm("");
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => onChange({ censorEnabled: !value.censorEnabled })}
          aria-pressed={value.censorEnabled}
          className={`pill ${value.censorEnabled ? "border-accent/50 text-accent" : ""}`}
        >
          {value.censorEnabled ? "✓ censoring on" : "censoring off"}
        </button>
        <span className="text-xs text-muted">
          {spans.length === 0
            ? "nothing flagged in this clip"
            : `${spans.length} word${spans.length === 1 ? "" : "s"} flagged`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5">
          sensitivity
          <select
            value={value.censorSensitivity}
            onChange={(e) =>
              onChange({ censorSensitivity: e.target.value as CensorSettings["censorSensitivity"] })
            }
            className="field py-0.5"
          >
            {SENSITIVITIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.hint}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex items-center gap-1.5"
          title={
            value.censorAudioEnabled
              ? undefined
              : "Audio censoring is switched off for this clip — the captions are masked but the speech is left audible."
          }
        >
          <input
            type="checkbox"
            checked={value.censorAudioEnabled}
            onChange={(e) => onChange({ censorAudioEnabled: e.target.checked })}
            aria-label="Bleep censored words in the audio"
            className="h-3 w-3 cursor-pointer accent-[rgb(var(--c-danger))]"
          />
          audio
          <select
            disabled={!value.censorAudioEnabled}
            value={value.censorAudioMode}
            onChange={(e) =>
              onChange({ censorAudioMode: e.target.value as CensorSettings["censorAudioMode"] })
            }
            className="field py-0.5 disabled:opacity-50"
          >
            {AUDIO_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          captions
          <select
            value={value.censorCaptionMode}
            onChange={(e) =>
              onChange({ censorCaptionMode: e.target.value as CensorSettings["censorCaptionMode"] })
            }
            className="field py-0.5"
          >
            {CAPTION_CENSOR_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.sample})
              </option>
            ))}
          </select>
        </label>
        {value.censorCaptionMode === "CUSTOM" && (
          <input
            value={value.censorReplacement ?? ""}
            onChange={(e) => onChange({ censorReplacement: e.target.value || null })}
            placeholder="[BLEEP]"
            aria-label="Replacement text"
            className="field w-28 py-0.5"
          />
        )}
      </div>

      <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
        <summary className="cursor-pointer text-muted">
          Review flagged words{spans.length ? ` · ${spans.length}` : ""}
        </summary>
        <div className="flex flex-col gap-2 pt-2">
          {spans.length === 0 ? (
            <p className="text-muted">
              Nothing matched at this sensitivity. Add your own terms below if something is missing —
              the built-in list covers profanity and slurs.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {spans.map((s, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono tabular-nums text-muted">{fmt(s.startMs)}</span>
                  <span className="font-mono">{s.text}</span>
                  <span className="text-muted">→</span>
                  <span className="font-mono">
                    {/* An audio-only occurrence changes no caption, so showing
                        it a mask would promise a substitution that never
                        happens. */}
                    {!outcome.masked.has(s.wordId ?? "")
                      ? "—"
                      : maskWord(
                      s.text,
                      (s.wordId && value.censorWordOverrides[s.wordId]?.captionMode) ||
                        value.censorCaptionMode,
                      (s.wordId ? value.censorWordOverrides[s.wordId]?.replacement : null) ??
                        value.censorReplacement ??
                          undefined,
                      )}
                  </span>
                  <span className="chip">{s.tier}</span>
                  {/* What this occurrence will actually do, which the tier
                      alone no longer implies: the mask and the bleep are
                      switched separately and can differ per word. */}
                  <span
                    className={
                      outcome.masked.has(s.wordId ?? "") || outcome.bleeped.has(s.wordId ?? "")
                        ? "chip text-danger"
                        : "chip text-muted"
                    }
                  >
                    {outcome.bleeped.has(s.wordId ?? "")
                      ? outcome.masked.has(s.wordId ?? "")
                        ? `masked · ${SOUND_LABEL[soundOf(s.wordId)]}`
                        : SOUND_LABEL[soundOf(s.wordId)]
                      : outcome.masked.has(s.wordId ?? "")
                        ? "masked · audible"
                        : "not censored"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm ml-auto"
                    onClick={() => keep(s)}
                    title="Stop censoring this occurrence — no mask, no bleep"
                  >
                    Keep it
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDeny();
                }
              }}
              placeholder="also censor…"
              aria-label="Add a word to censor"
              className="field w-40 py-0.5"
            />
            <button type="button" onClick={addDeny} className="btn btn-sm">
              Add
            </button>
          </div>

          {(value.censorDenyList.length > 0 || value.censorAllowList.length > 0) && (
            <div className="flex flex-col gap-1">
              {value.censorDenyList.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted">also censored:</span>
                  {value.censorDenyList.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="chip"
                      title="Remove"
                      onClick={() =>
                        onChange({ censorDenyList: value.censorDenyList.filter((x) => x !== t) })
                      }
                    >
                      {t} ✕
                    </button>
                  ))}
                </div>
              )}
              {value.censorAllowList.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted">never censored:</span>
                  {value.censorAllowList.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="chip"
                      title="Remove"
                      onClick={() =>
                        onChange({ censorAllowList: value.censorAllowList.filter((x) => x !== t) })
                      }
                    >
                      {t} ✕
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </details>
    </div>
  );
});
