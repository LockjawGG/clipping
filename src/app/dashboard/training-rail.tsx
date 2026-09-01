"use client";

import { memo, useCallback, useEffect, useState } from "react";

/**
 * 🧠 AI Training — the repository's account of itself.
 *
 * The design brief for this panel is that it must be able to say what it
 * learned, in sentences, from the profile itself. That is the whole argument
 * for a statistical profile over a learned model at this data volume: a
 * dashboard that could only show a loss curve would be useless here.
 */

interface ProfileView {
  contentType: string;
  exampleCount: number;
  confidence: number;
  trainedAt: string;
  learned: string[];
}

interface Repository {
  totalExamples: number;
  profiles: ProfileView[];
}

/** Confidence stated in words, because a bare percentage implies false rigour. */
function confidenceLabel(confidence: number, exampleCount: number): string {
  if (exampleCount < 3) return "learning";
  if (confidence < 0.25) return "learning";
  if (confidence < 0.55) return "fair";
  if (confidence < 0.8) return "good";
  return "strong";
}

const TYPE_LABEL: Record<string, string> = {
  PODCAST: "Podcast",
  INTERVIEW: "Interview",
  GAMING: "Gaming",
  COMMENTARY: "Commentary",
  EDUCATIONAL: "Educational",
  NEWS: "News",
  VLOG: "Vlog",
  SHORT: "Shorts",
  LONGFORM: "Long-form",
  UNKNOWN: "Uncategorised",
};

export const TrainingRail = memo(function TrainingRail() {
  const [repo, setRepo] = useState<Repository | null>(null);
  const [busy, setBusy] = useState<"retrain" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [style, setStyle] = useState<string | null>(null);
  const [styleSaved, setStyleSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/training/repository");
      if (res.ok) setRepo((await res.json()) as Repository);
    } catch {
      /* a transient failure just leaves the last view on screen */
    }
  }, []);

  useEffect(() => {
    void load();
    void fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setStyle(s?.styleInstructions ?? ""))
      .catch(() => setStyle(""));
  }, [load]);

  /** Saved on blur: instructions are written in thought, not per keystroke. */
  const saveStyle = async (text: string) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ styleInstructions: text }),
      });
      if (!res.ok) throw new Error();
      setStyleSaved(true);
      setTimeout(() => setStyleSaved(false), 1600);
    } catch {
      setError("style rules didn't save - try again");
    }
  };

  const call = async (kind: "retrain" | "clear", req: () => Promise<Response>) => {
    setBusy(kind);
    setError(null);
    try {
      const res = await req();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const retrain = () =>
    call("retrain", () => fetch("/api/training/retrain", { method: "POST" }));

  const clear = () => {
    if (
      !window.confirm(
        "Forget everything learned so far? Your projects are untouched — only the training repository and the profiles built from it are deleted.",
      )
    ) {
      return;
    }
    void call("clear", () => fetch("/api/training/retrain", { method: "DELETE" }));
  };

  const total = repo?.totalExamples ?? 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="rail-heading">🧠 AI Training</div>

      {/* The yap-style instruction set: rules the AI follows, in the user's
          own words. Sits above the learned stats because it is the half the
          user writes rather than the half the app infers. */}
      {style !== null && (
        <div className="flex flex-col gap-1 px-2.5 pb-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium">How I edit</span>
            <span className={`text-xs text-accent transition-opacity ${styleSaved ? "opacity-100" : "opacity-0"}`}>
              Saved ✓
            </span>
          </div>
          <textarea
            defaultValue={style}
            onBlur={(e) => void saveStyle(e.target.value.slice(0, 4000))}
            rows={5}
            placeholder={[
              "Your editing rules, in plain words. e.g.",
              "- clips 20-40s, always end on a punchline",
              "- bold captions, censor all profanity",
              "- cut every pause longer than 2s",
            ].join("\n")}
            className="field resize-y text-xs leading-relaxed"
          />
          <p className="text-xs leading-relaxed text-muted">
            The AI follows these rules when it suggests clips and when you talk to the assistant -
            like handing your editor a style guide.
          </p>
        </div>
      )}

      {total === 0 ? (
        <p className="px-2.5 pb-2 text-xs leading-relaxed text-muted">
          Nothing learned yet. Approve a finished clip with{" "}
          <span className="text-text">Train on this</span> and the editor starts picking up your
          pacing, caption style and motion.
        </p>
      ) : (
        <>
          <div className="px-2.5 pb-1 text-xs text-muted">
            {total} approved edit{total === 1 ? "" : "s"} across {repo?.profiles.length ?? 0} content
            type{(repo?.profiles.length ?? 0) === 1 ? "" : "s"}
          </div>

          {repo?.profiles.map((p) => (
            <details key={p.contentType} className="rounded-lg px-2.5 py-1.5 hover:bg-surface">
              <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm">
                <span>{TYPE_LABEL[p.contentType] ?? p.contentType}</span>
                <span className="font-mono text-[11px] tabular-nums text-muted">
                  {p.exampleCount} · {confidenceLabel(p.confidence, p.exampleCount)}
                </span>
              </summary>
              <ul className="flex flex-col gap-1 pt-2 text-[11px] leading-relaxed text-muted">
                {p.learned.length === 0 ? (
                  <li>Not enough consistent examples to describe a style yet.</li>
                ) : (
                  p.learned.map((line, i) => <li key={i}>{line}</li>)
                )}
              </ul>
            </details>
          ))}
        </>
      )}

      {error && <p className="px-2.5 text-xs text-danger">{error}</p>}

      <div className="flex flex-wrap gap-1.5 px-2.5 pt-1">
        <button
          type="button"
          onClick={retrain}
          disabled={busy !== null || total === 0}
          className="btn btn-sm"
          title="Rebuild every profile from the approved edits"
        >
          {busy === "retrain" ? "Retraining…" : "Retrain"}
        </button>
        {total > 0 && (
          <button
            type="button"
            onClick={clear}
            disabled={busy !== null}
            className="btn btn-danger btn-sm"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
});
