"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { duckLabel, DUCK_DEFAULT_DB, DUCK_SILENT_DB } from "@/lib/voiceover/duck.ts";

/**
 * 🎙 AI Voiceover for one clip.
 *
 * The panel is honest about the provider: text-to-speech runs locally, so if
 * the binary or the voices are missing it says exactly what to install rather
 * than failing at synthesis time with a stack trace.
 */

interface Voice {
  id: string;
  label: string;
  language: string;
}

/** One synthesized line of narration, ready for the editor to place. */
export interface PreviewLine {
  ref: string;
  durationMs: number;
  url: string;
}

interface Voiceover {
  id: string;
  sourceKind: string;
  script: string | null;
  language: string;
  voiceId: string;
  speed: number;
  duckDb: number;
  enabled: boolean;
  status: string;
  errorMessage: string | null;
  lineCount: number;
  lines: PreviewLine[];
}

const SOURCES: Array<{ id: string; label: string; hint: string }> = [
  { id: "TRANSCRIPT", label: "Transcript", hint: "read what was said" },
  { id: "SCRIPT", label: "Script", hint: "read text you write" },
];

export const VoiceoverPanel = memo(function VoiceoverPanel({
  clipId,
  onLines,
  reloadReq = 0,
}: {
  clipId: string;
  /** Hand the placed lines up so the preview can play them. */
  onLines?: (lines: PreviewLine[], duckDb: number) => void;
  /**
   * Bumped when something outside this panel re-queued the synthesis — saving
   * censor changes does, because the narration is spoken through them. The
   * panel then re-reads, sees the row running, and polls the fresh recording
   * into the preview when it lands.
   */
  reloadReq?: number;
}) {
  const [vo, setVo] = useState<Voiceover | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/clips/${clipId}/voiceover`);
      if (!res.ok) return;
      const body = (await res.json()) as Voiceover | null;
      setVo(body);
      onLines?.(body?.enabled === false ? [] : (body?.lines ?? []), body?.duckDb ?? 0);
      if (body?.script != null) setScript((s) => (s === "" ? body.script! : s));
    } catch {
      /* the next poll retries */
    }
  }, [clipId, onLines]);

  useEffect(() => {
    void load();
    void fetch("/api/tts/voices")
      .then((r) => r.json())
      .then((b: { voices: Voice[]; available: boolean; hint: string | null }) => {
        setVoices(b.voices);
        setAvailable(b.available);
        setHint(b.hint);
      })
      .catch(() => {});
  }, [load]);

  useEffect(() => {
    if (reloadReq > 0) void load();
  }, [reloadReq, load]);

  const running = vo?.status === "QUEUED" || vo?.status === "PROCESSING";
  useEffect(() => {
    if (!running) return;
    poll.current = setTimeout(() => void load(), 2000);
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [running, load, vo]);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/voiceover`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't generate the voiceover");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await fetch(`/api/clips/${clipId}/voiceover`, { method: "DELETE" }).catch(() => {});
    setVo(null);
    // The preview has to stop playing narration that no longer exists.
    onLines?.([], 0);
  };

  const sourceKind = vo?.sourceKind ?? "TRANSCRIPT";
  const on = vo?.enabled !== false;
  /** Flip the narration without re-synthesizing it. */
  const toggle = async () => {
    if (!vo) return;
    const next = !on;
    setVo((v) => (v ? { ...v, enabled: next } : v));
    onLines?.(next ? (vo.lines ?? []) : [], vo.duckDb);
    await save({ enabled: next });
  };

  return (
    <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
      <summary className="cursor-pointer text-muted">
        🎙 Voiceover
        {vo && !running && vo.lineCount > 0 && (
          <span className={`ml-2 text-[11px] ${on ? "" : "line-through"}`}>
            {vo.lineCount} lines
          </span>
        )}
        {vo && !running && vo.lineCount > 0 && !on && (
          <span className="ml-2 text-[11px] text-muted">· muted</span>
        )}
        {running && <span className="ml-2 text-accent">generating…</span>}
      </summary>

      <div className="flex flex-col gap-2 pt-2">
        {vo && vo.lineCount > 0 && (
          <div className="flex items-center gap-2 rounded-md bg-surface px-2 py-1.5">
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label="Play the narration"
              disabled={busy}
              onClick={toggle}
              className="switch"
            />
            <span className="font-medium">{on ? "Narration on" : "Narration off"}</span>
            <span className="text-[11px] text-muted">
              {on
                ? "Mixed into the preview and the export."
                : "Kept, but silent — switch back on any time."}
            </span>
          </div>
        )}
        {!available && (
          <p className="text-[11px] leading-relaxed text-danger">
            Text-to-speech isn&apos;t set up: {hint}. Voiceovers run locally, so nothing is sent
            anywhere — you just need the binary and at least one voice installed.
          </p>
        )}
        {available && voices.length === 0 && (
          <p className="text-[11px] leading-relaxed text-danger">
            No voice models installed. Drop a Piper <code>.onnx</code> voice into the folder
            <code> PIPER_VOICE_DIR</code> points at and it will appear here.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex items-center gap-1">
            read
            <select
              value={sourceKind}
              onChange={(e) => save({ sourceKind: e.target.value })}
              className="field py-0.5"
              disabled={busy}
            >
              {SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {s.hint}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1">
            voice
            <select
              value={vo?.voiceId ?? ""}
              onChange={(e) => save({ voiceId: e.target.value })}
              className="field py-0.5"
              disabled={busy || voices.length === 0}
            >
              <option value="">auto</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.language}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2">
            speed {(vo?.speed ?? 1).toFixed(2)}×
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={vo?.speed ?? 1}
              onChange={(e) => setVo((v) => (v ? { ...v, speed: Number(e.target.value) } : v))}
              onPointerUp={(e) => save({ speed: Number((e.target as HTMLInputElement).value) })}
              disabled={busy}
            />
          </label>

          <label className="flex items-center gap-2" title="How far the clip's own audio drops while the narration plays. At the bottom of the range it is silent, so the narration covers it rather than competing with it.">
            duck {duckLabel(vo?.duckDb ?? DUCK_DEFAULT_DB)}
            <input
              type="range"
              min={DUCK_SILENT_DB}
              max={0}
              step={1}
              value={vo?.duckDb ?? DUCK_DEFAULT_DB}
              onChange={(e) => setVo((v) => (v ? { ...v, duckDb: Number(e.target.value) } : v))}
              onPointerUp={(e) => save({ duckDb: Number((e.target as HTMLInputElement).value) })}
              disabled={busy}
            />
          </label>
        </div>

        {sourceKind === "SCRIPT" && (
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="One line per paragraph. Each is spoken in order, spread across the clip."
            rows={4}
            className="field w-full"
            aria-label="Voiceover script"
          />
        )}

        {error && <p className="text-danger">{error}</p>}
        {vo?.status === "FAILED" && (
          <p className="text-danger">{vo.errorMessage ?? "synthesis failed"}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || running || !available || voices.length === 0}
            onClick={() =>
              save(sourceKind === "SCRIPT" ? { sourceKind, script } : { sourceKind })
            }
          >
            {running ? "Generating…" : vo?.lineCount ? "Regenerate" : "Generate"}
          </button>
          {vo && (
            <button type="button" className="btn btn-danger btn-sm" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <span className="text-[11px] text-muted">
            Narration follows the transcript, so trimming the clip moves it too.
          </span>
        </div>
      </div>
    </details>
  );
});
