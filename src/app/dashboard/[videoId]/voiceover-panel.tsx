"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";

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

interface Voiceover {
  id: string;
  sourceKind: string;
  script: string | null;
  language: string;
  voiceId: string;
  speed: number;
  duckDb: number;
  status: string;
  errorMessage: string | null;
  lineCount: number;
}

const SOURCES: Array<{ id: string; label: string; hint: string }> = [
  { id: "TRANSCRIPT", label: "Transcript", hint: "read what was said" },
  { id: "SCRIPT", label: "Script", hint: "read text you write" },
];

export const VoiceoverPanel = memo(function VoiceoverPanel({ clipId }: { clipId: string }) {
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
      if (body?.script != null) setScript((s) => (s === "" ? body.script! : s));
    } catch {
      /* the next poll retries */
    }
  }, [clipId]);

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
  };

  const sourceKind = vo?.sourceKind ?? "TRANSCRIPT";

  return (
    <details className="rounded border border-border bg-surface-raised px-2 py-1 text-xs">
      <summary className="cursor-pointer text-muted">
        🎙 Voiceover
        {vo && !running && vo.lineCount > 0 && (
          <span className="ml-2 text-[11px]">{vo.lineCount} lines</span>
        )}
        {running && <span className="ml-2 text-accent">generating…</span>}
      </summary>

      <div className="flex flex-col gap-2 pt-2">
        {!available && (
          <p className="text-[11px] leading-relaxed text-danger">
            Text-to-speech isn&apos;t set up: {hint}. Voiceovers run locally, so nothing is sent
            anywhere — you just need the binary and at least one voice installed.
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

          <label className="flex items-center gap-2" title="How far the clip's own audio drops while the narration plays">
            duck {(vo?.duckDb ?? -12).toFixed(0)} dB
            <input
              type="range"
              min={-30}
              max={0}
              step={1}
              value={vo?.duckDb ?? -12}
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
            disabled={busy || running || !available}
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
