"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The local editing assistant, in the editor.
 *
 * A conversation about the open video with a model that runs on this machine —
 * nothing leaves it. The model never edits anything itself: it proposes, each
 * proposal renders as a card, and only the Approve button acts, by calling the
 * same endpoints the rest of the UI already uses. Deny simply dismisses.
 *
 * Without Ollama installed the panel stays honest: one quiet line saying what
 * it would take to turn on, no dead chat box.
 */

interface Proposal {
  action: "create_clip" | "add_censor_word";
  startMs?: number;
  endMs?: number;
  title?: string;
  word?: string;
  reason: string;
  /** UI state, not model output. */
  resolved?: "approved" | "denied";
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  proposals?: Proposal[];
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function AssistantPanel({ videoId }: { videoId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ available: boolean; model: string | null } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || status !== null) return;
    void fetch("/api/assistant/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setStatus(b ?? { available: false, model: null }))
      .catch(() => setStatus({ available: false, model: null }));
  }, [open, status]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError(null);
    const next: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(next);
    setBusy(true);
    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoId,
          messages: next.map((t) => ({ role: t.role, content: t.content })).slice(-16),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "the assistant did not answer");
      setTurns((cur) => [
        ...cur,
        { role: "assistant", content: body.reply || "(no reply)", proposals: body.proposals ?? [] },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "the assistant did not answer");
      setTurns((cur) => cur.slice(0, -1)); // put the failed question back in the box
      setDraft(text);
    } finally {
      setBusy(false);
    }
  };

  const resolve = (turnIdx: number, propIdx: number, resolved: "approved" | "denied") => {
    setTurns((cur) =>
      cur.map((t, i) =>
        i === turnIdx
          ? { ...t, proposals: t.proposals?.map((p, j) => (j === propIdx ? { ...p, resolved } : p)) }
          : t,
      ),
    );
  };

  const approve = async (turnIdx: number, propIdx: number, p: Proposal) => {
    try {
      if (p.action === "create_clip") {
        const res = await fetch(`/api/videos/${videoId}/clips`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ startMs: p.startMs, endMs: p.endMs, title: p.title }),
        });
        if (!res.ok) throw new Error();
        router.refresh();
      } else if (p.action === "add_censor_word" && p.word) {
        const cur = await (await fetch("/api/settings")).json();
        const list: string[] = cur.censorDenyList ?? [];
        if (!list.includes(p.word)) {
          const res = await fetch("/api/settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ censorDenyList: [...list, p.word] }),
          });
          if (!res.ok) throw new Error();
        }
      }
      resolve(turnIdx, propIdx, "approved");
    } catch {
      setError("that approval didn't go through — try again");
    }
  };

  return (
    <section className="card flex flex-col gap-3 p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 text-left"
      >
        <span className="btn btn-ghost btn-sm w-7 shrink-0">{open ? "▾" : "▸"}</span>
        <span className="text-sm font-semibold">✦ Assistant</span>
        <span className="text-xs text-muted">
          plan edits with a local model — it proposes, you approve
        </span>
      </button>

      {open && status && !status.available && (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">
          Runs on a free local model, fully offline. Install{" "}
          <span className="font-medium text-text">Ollama</span> from ollama.com, run{" "}
          <code className="chip">ollama pull llama3.2</code> once, and this panel wakes up on its
          own — nothing you say here ever leaves this computer.
        </p>
      )}

      {open && status?.available && (
        <>
          {turns.length > 0 && (
            <div className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
              {turns.map((t, ti) => (
                <div key={ti} className="flex flex-col gap-1.5">
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${
                      t.role === "user"
                        ? "self-end bg-accent text-accent-fg"
                        : "self-start bg-surface-raised"
                    }`}
                  >
                    {t.content}
                  </div>
                  {t.proposals?.map((p, pi) => (
                    <div
                      key={pi}
                      className={`flex flex-col gap-1.5 self-start rounded-xl border px-3 py-2 text-xs ${
                        p.resolved === "approved"
                          ? "border-accent/40"
                          : p.resolved === "denied"
                            ? "border-border opacity-50"
                            : "border-accent/40 bg-accent/5"
                      }`}
                    >
                      <span className="font-medium">
                        {p.action === "create_clip"
                          ? `New clip ${mmss(p.startMs ?? 0)}–${mmss(p.endMs ?? 0)} · “${p.title}”`
                          : `Always censor “${p.word}”`}
                      </span>
                      <span className="text-muted">{p.reason}</span>
                      {p.resolved ? (
                        <span className={p.resolved === "approved" ? "text-accent" : "text-muted"}>
                          {p.resolved === "approved" ? "✓ approved" : "dismissed"}
                        </span>
                      ) : (
                        <span className="flex gap-2">
                          <button type="button" className="btn btn-sm bg-accent text-accent-fg"
                            onClick={() => void approve(ti, pi, p)}>
                            Approve
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm"
                            onClick={() => resolve(ti, pi, "denied")}>
                            Deny
                          </button>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              {busy && <p className="self-start text-xs text-muted">thinking…</p>}
              <div ref={endRef} />
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), void send())}
              placeholder='Try “find the 3 best moments” or “what should I cut?”'
              disabled={busy}
              className="field min-w-0 flex-1 text-sm"
            />
            <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()}
              className="btn bg-accent text-accent-fg">
              {busy ? "…" : "Send"}
            </button>
          </div>
          {status.model && (
            <p className="text-right text-[11px] text-muted">local model · {status.model}</p>
          )}
        </>
      )}
    </section>
  );
}
