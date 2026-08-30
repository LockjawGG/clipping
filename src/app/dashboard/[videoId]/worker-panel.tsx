"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";

/**
 * The AI worker's review panel.
 *
 * The design rule here is that nothing applies on its own. Every suggestion
 * shows what was measured, and accepting one is an explicit act — which is also
 * what makes the accept/reject signal worth learning from. A run never edits
 * the project; it only proposes.
 */

interface Suggestion {
  id: string;
  kind: string;
  startMs: number;
  endMs: number;
  score: number;
  reason: string;
  status: string;
  payloadJson: {
    title?: string;
    hook?: string;
    signals?: {
      energy?: number;
      flatness?: number;
      silenceRatio?: number;
      transcript?: number;
      savedMs?: number;
    };
  } | null;
}

interface Run {
  id: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  suggestions: Suggestion[];
}

const KIND_LABEL: Record<string, string> = {
  HIGHLIGHT: "Highlight",
  REACTION: "Reaction",
  DEAD_AIR: "Dead air",
};

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const pct = (n: number | undefined) => (n === undefined ? null : `${Math.round(n * 100)}%`);

interface Props {
  videoId: string;
  /** Jump the player to a suggestion's start (absolute video ms). */
  onSeek?: (ms: number) => void;
}

export const WorkerPanel = memo(function WorkerPanel({ videoId, onSeek }: Props) {
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [objectives, setObjectives] = useState({
    highlights: true,
    reactions: true,
    deadAir: true,
  });
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/videos/${videoId}/worker`);
      if (!res.ok) return;
      setRun((await res.json()) as Run | null);
    } catch {
      /* a transient fetch failure just means the next poll tries again */
    }
  }, [videoId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while a run is in flight, then stop — an idle panel makes no
  // requests at all.
  useEffect(() => {
    if (!run || (run.status !== "QUEUED" && run.status !== "PROCESSING")) return;
    poll.current = setTimeout(() => void load(), 2000);
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [run, load]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/worker`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objectives }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "couldn't start the worker");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, status: "ACCEPTED" | "REJECTED" | "PENDING") => {
    // Optimistic: the decision is local and instantly reversible.
    setRun((r) =>
      r ? { ...r, suggestions: r.suggestions.map((s) => (s.id === id ? { ...s, status } : s)) } : r,
    );
    try {
      await fetch(`/api/worker-suggestions/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
    } catch {
      void load();
    }
  };

  const running = run?.status === "QUEUED" || run?.status === "PROCESSING";
  const pending = run?.suggestions.filter((s) => s.status === "PENDING") ?? [];
  const decided = run?.suggestions.filter((s) => s.status !== "PENDING") ?? [];

  return (
    <details className="card px-3 py-2 text-sm">
      <summary className="cursor-pointer select-none font-medium">
        ⚡ Run Worker
        {run && !running && run.suggestions.length > 0 && (
          <span className="ml-2 text-xs text-muted">
            {pending.length} to review
            {decided.length > 0 ? ` · ${decided.length} decided` : ""}
          </span>
        )}
        {running && <span className="ml-2 text-xs text-accent">working…</span>}
      </summary>

      <div className="flex flex-col gap-3 pt-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {(
            [
              ["highlights", "Highlights"],
              ["reactions", "Reactions"],
              ["deadAir", "Dead air"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={objectives[key]}
              onClick={() => setObjectives((o) => ({ ...o, [key]: !o[key] }))}
              className={`pill ${objectives[key] ? "border-accent/50 text-accent" : ""}`}
            >
              {objectives[key] ? "✓ " : ""}
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={start}
            disabled={busy || running}
            className="btn btn-primary btn-sm ml-auto"
          >
            {running ? "Working…" : run ? "Run again" : "Run worker"}
          </button>
        </div>

        <p className="text-[11px] text-muted">
          The worker only proposes. Nothing changes until you accept a suggestion.
        </p>

        {error && <p className="text-xs text-danger">{error}</p>}
        {run?.status === "FAILED" && (
          <p className="text-xs text-danger">{run.errorMessage ?? "the run failed"}</p>
        )}

        {run && !running && run.suggestions.length === 0 && (
          <p className="text-xs text-muted">
            Nothing to suggest for this video yet. A transcript and the audio pass both feed this —
            if the video just finished processing, try again in a moment.
          </p>
        )}

        {[...pending, ...decided].map((s) => {
          const sig = s.payloadJson?.signals ?? {};
          const done = s.status !== "PENDING";
          return (
            <div
              key={s.id}
              className={`rounded-lg border border-border bg-surface-raised px-3 py-2 ${done ? "opacity-60" : ""}`}
            >
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="chip">{KIND_LABEL[s.kind] ?? s.kind}</span>
                {s.payloadJson?.title && <span className="font-medium">{s.payloadJson.title}</span>}
                <button
                  type="button"
                  className="font-mono text-xs tabular-nums text-muted hover:text-text"
                  onClick={() => onSeek?.(s.startMs)}
                  title="Jump the player here"
                >
                  {fmt(s.startMs)}–{fmt(s.endMs)}
                </button>
                <span className="chip">{Math.round(s.score * 100)}%</span>
              </div>

              <p className="mb-2 text-xs leading-relaxed text-muted">{s.reason}</p>

              {/* The measurements behind the claim, so it is auditable. */}
              <div className="mb-2 flex flex-wrap gap-1">
                {pct(sig.transcript) && <span className="chip">transcript {pct(sig.transcript)}</span>}
                {pct(sig.energy) && <span className="chip">energy {pct(sig.energy)}</span>}
                {sig.flatness !== undefined && (
                  <span className="chip">flatness {sig.flatness.toFixed(2)}</span>
                )}
                {sig.silenceRatio !== undefined && sig.silenceRatio > 0.05 && (
                  <span className="chip">silence {pct(sig.silenceRatio)}</span>
                )}
                {sig.savedMs !== undefined && (
                  <span className="chip">saves {(sig.savedMs / 1000).toFixed(1)}s</span>
                )}
              </div>

              {done ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">
                    {s.status === "ACCEPTED" ? "accepted" : "rejected"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => decide(s.id, "PENDING")}
                  >
                    Undo
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => decide(s.id, "ACCEPTED")}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => decide(s.id, "REJECTED")}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
});
