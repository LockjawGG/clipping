"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CaptionControls, CAPTION_DEFAULTS, type CaptionConfig } from "./caption-controls";
import { ClipPlayer, type PreviewWord } from "./clip-player";
import { EditableTranscript, type TranscriptRow } from "./editable-transcript";

const ASPECTS = [
  ["VERTICAL_9_16", "9:16"],
  ["SQUARE_1_1", "1:1"],
  ["LANDSCAPE_16_9", "16:9"],
  ["PORTRAIT_4_5", "4:5"],
] as const;

export interface ClipData {
  id: string;
  origin: string;
  title: string;
  startMs: number;
  endMs: number;
  score: number | null;
  aspectRatio: string;
  focalX: number | null;
  focalY: number | null;
  accepted: boolean;
  savedToProjectId: string | null;
  captions: CaptionConfig | null;
  thumbnailUrl: string | null;
  render: { id: string; status: string; progress: number; downloadUrl: string | null } | null;
}

const s = (ms: number) => (ms / 1000).toFixed(1);
const MIN_LEN_MS = 100;

export function ClipEditor({
  clip,
  sourceUrl,
  words,
  transcript,
  projects,
}: {
  clip: ClipData;
  sourceUrl: string;
  words: PreviewWord[];
  transcript: TranscriptRow[];
  projects: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(clip);
  const [busy, setBusy] = useState<"save" | "render" | "delete" | "thumb" | "save-to" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [captionsOn, setCaptionsOn] = useState(clip.captions !== null);
  const [captionDraft, setCaptionDraft] = useState<CaptionConfig>(clip.captions ?? CAPTION_DEFAULTS);
  const [saveMenu, setSaveMenu] = useState(false);

  const storageKey = `clip-collapsed:${clip.id}`;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(storageKey) === "1");
    } catch {
      /* private mode */
    }
  }, [storageKey]);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!saveMenu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setSaveMenu(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [saveMenu]);

  const savedProject = projects.find((p) => p.id === clip.savedToProjectId) ?? null;

  const rendering = clip.render?.status === "QUEUED" || clip.render?.status === "PROCESSING";

  const dirty =
    draft.title !== clip.title ||
    draft.startMs !== clip.startMs ||
    draft.endMs !== clip.endMs ||
    draft.aspectRatio !== clip.aspectRatio ||
    draft.focalX !== clip.focalX ||
    draft.focalY !== clip.focalY ||
    draft.accepted !== clip.accepted;

  async function call(kind: NonNullable<typeof busy>, req: () => Promise<Response>) {
    setBusy(kind);
    setError(null);
    try {
      const res = await req();
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${kind} failed`);
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      return false;
    } finally {
      setBusy(null);
    }
  }

  const saveReq = () =>
    fetch(`/api/clips/${clip.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: draft.title,
        startMs: Math.round(draft.startMs),
        endMs: Math.round(draft.endMs),
        aspectRatio: draft.aspectRatio,
        focalX: draft.focalX,
        focalY: draft.focalY,
        accepted: draft.accepted,
      }),
    });
  const renderReq = () => fetch(`/api/clips/${clip.id}/render`, { method: "POST" });

  const save = () => call("save", saveReq);
  const render = () => call("render", renderReq);
  const saveAndRender = async () => {
    const ok = dirty ? await call("save", saveReq) : true;
    if (ok) await call("render", renderReq);
  };
  const remove = () => call("delete", () => fetch(`/api/clips/${clip.id}`, { method: "DELETE" }));
  const thumbnail = () =>
    call("thumb", () => fetch(`/api/clips/${clip.id}/thumbnail`, { method: "POST" }));
  const saveTo = (projectId: string | null) => {
    setSaveMenu(false);
    return call("save-to", () =>
      fetch(`/api/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ savedToProjectId: projectId }),
      }),
    );
  };

  const setStartToPlayhead = () =>
    setDraft((d) => ({
      ...d,
      startMs: Math.min(Math.max(0, clip.startMs + playheadMs), d.endMs - MIN_LEN_MS),
    }));
  const setEndToPlayhead = () =>
    setDraft((d) => ({
      ...d,
      endMs: Math.max(clip.startMs + playheadMs, d.startMs + MIN_LEN_MS),
    }));

  const nudge = (field: "startMs" | "endMs", deltaMs: number) =>
    setDraft((d) => ({ ...d, [field]: Math.max(0, d[field] + deltaMs) }));
  const setField = (field: "startMs" | "endMs", seconds: number) =>
    setDraft((d) => ({ ...d, [field]: Math.max(0, Math.round(seconds * 1000)) }));

  const pct = clip.render ? Math.round(clip.render.progress * 100) : 0;

  return (
    <div className="card flex flex-col gap-4 p-4">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand clip" : "Minimize clip"}
          className="btn btn-ghost btn-sm mt-1 w-7 shrink-0"
        >
          {collapsed ? "▸" : "▾"}
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL */}
        <img
          src={clip.thumbnailUrl ?? undefined}
          alt=""
          className={`shrink-0 rounded-lg bg-surface-raised object-cover ${collapsed ? "h-9 w-16" : "h-16 w-28"}`}
        />
        <input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold hover:border-border focus-visible:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        />
        {collapsed && (
          <span className="shrink-0 self-center font-mono text-xs text-muted">
            {s(Math.max(0, clip.endMs - clip.startMs))}s
          </span>
        )}
        <span className="chip shrink-0">
          {draft.origin === "USER_CREATED" ? "manual" : "AI"}
          {draft.score !== null ? ` · ${draft.score.toFixed(2)}` : ""}
        </span>

        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setSaveMenu((v) => !v)}
            disabled={busy !== null || projects.length === 0}
            aria-haspopup="menu"
            aria-expanded={saveMenu}
            className={`btn btn-ghost btn-sm ${savedProject ? "text-accent" : ""}`}
          >
            {busy === "save-to" ? "…" : savedProject ? `✓ ${savedProject.name}` : "Save to ▸"}
          </button>
          {saveMenu && (
            <div className="menu right-0 top-9" role="menu">
              <p className="px-2 py-1 text-xs text-muted">Save this clip to…</p>
              {projects.map((p) => (
                <button
                  key={p.id}
                  role="menuitemradio"
                  aria-checked={p.id === clip.savedToProjectId}
                  onClick={() => saveTo(p.id)}
                >
                  {p.id === clip.savedToProjectId ? "● " : "○ "}
                  {p.name}
                </button>
              ))}
              {clip.savedToProjectId && (
                <button className="text-danger" onClick={() => saveTo(null)}>
                  Remove from saved
                </button>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={thumbnail}
          disabled={busy !== null}
          className="btn btn-ghost btn-sm shrink-0"
        >
          {busy === "thumb" ? "…" : clip.thumbnailUrl ? "↻ thumb" : "Thumbnail"}
        </button>
      </div>

      {!collapsed && (
      <>
      <ClipPlayer
        sourceUrl={sourceUrl}
        startMs={clip.startMs}
        endMs={clip.endMs}
        words={words}
        captionsOn={captionsOn}
        caption={captionDraft}
        renderUrl={clip.render?.downloadUrl ?? null}
        onPlayhead={setPlayheadMs}
        onCaptionLayout={(l) => setCaptionDraft((d) => ({ ...d, ...l }))}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-surface-raised px-3 py-2 text-sm">
        <button type="button" onClick={setStartToPlayhead} className="btn btn-sm">
          ⇤ Set start
        </button>
        <span className="flex items-center gap-1">
          <button onClick={() => nudge("startMs", -1000)} className="btn btn-ghost btn-sm">
            −1s
          </button>
          <button onClick={() => nudge("startMs", -100)} className="btn btn-ghost btn-sm">
            −.1
          </button>
          <input
            type="number"
            step={0.1}
            min={0}
            value={s(draft.startMs)}
            onChange={(e) => setField("startMs", Number(e.target.value))}
            className="field w-20 font-mono tabular-nums"
          />
          <button onClick={() => nudge("startMs", 100)} className="btn btn-ghost btn-sm">
            +.1
          </button>
          <button onClick={() => nudge("startMs", 1000)} className="btn btn-ghost btn-sm">
            +1s
          </button>
        </span>

        <button type="button" onClick={setEndToPlayhead} className="btn btn-sm">
          Set end ⇥
        </button>
        <span className="flex items-center gap-1">
          <button onClick={() => nudge("endMs", -1000)} className="btn btn-ghost btn-sm">
            −1s
          </button>
          <button onClick={() => nudge("endMs", -100)} className="btn btn-ghost btn-sm">
            −.1
          </button>
          <input
            type="number"
            step={0.1}
            min={0}
            value={s(draft.endMs)}
            onChange={(e) => setField("endMs", Number(e.target.value))}
            className="field w-20 font-mono tabular-nums"
          />
          <button onClick={() => nudge("endMs", 100)} className="btn btn-ghost btn-sm">
            +.1
          </button>
          <button onClick={() => nudge("endMs", 1000)} className="btn btn-ghost btn-sm">
            +1s
          </button>
        </span>
        <span className="font-mono text-xs text-muted">
          {s(Math.max(0, draft.endMs - draft.startMs))}s long
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
        <label className="flex items-center gap-1.5">
          aspect
          <select
            value={draft.aspectRatio}
            onChange={(e) => setDraft({ ...draft, aspectRatio: e.target.value })}
            className="field py-1"
          >
            {ASPECTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {(["focalX", "focalY"] as const).map((axis) => (
          <label key={axis} className="flex items-center gap-2">
            {axis === "focalX" ? "focal X" : "focal Y"}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft[axis] ?? 0.5}
              onChange={(e) => setDraft({ ...draft, [axis]: Number(e.target.value) })}
            />
            <span className="font-mono tabular-nums text-muted">
              {(draft[axis] ?? 0.5).toFixed(2)}
            </span>
          </label>
        ))}
        <button
          type="button"
          onClick={() => setDraft({ ...draft, accepted: !draft.accepted })}
          aria-pressed={draft.accepted}
          className={`pill ${draft.accepted ? "border-accent/50 text-accent" : ""}`}
        >
          {draft.accepted ? "✓ accepted" : "mark accepted"}
        </button>
      </div>

      <CaptionControls
        clipId={clip.id}
        exists={clip.captions !== null}
        captionsOn={captionsOn}
        onCaptionsOnChange={setCaptionsOn}
        value={captionDraft}
        onChange={setCaptionDraft}
      />

      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted">Transcript for this clip</p>
        <EditableTranscript rows={transcript} />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button onClick={save} disabled={!dirty || busy !== null} className="btn btn-primary">
          {busy === "save" ? "…" : "Save"}
        </button>
        <button onClick={saveAndRender} disabled={busy !== null || rendering} className="btn">
          {busy === "render" || rendering ? "Rendering…" : "Save & render"}
        </button>
        <button
          onClick={render}
          disabled={busy !== null || rendering || dirty}
          className="btn btn-ghost"
          title={dirty ? "Save first, or use Save & render" : undefined}
        >
          {clip.render ? "Re-render" : "Render"}
        </button>
        <button onClick={remove} disabled={busy !== null} className="btn btn-ghost btn-danger">
          Delete
        </button>

        {clip.render && (
          <div className="ml-auto flex items-center gap-2">
            <span className="pill">{clip.render.status.toLowerCase()}</span>
            {rendering && (
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-raised">
                <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
            {clip.render.downloadUrl && (
              <a href={clip.render.downloadUrl} className="text-accent underline">
                download
              </a>
            )}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
