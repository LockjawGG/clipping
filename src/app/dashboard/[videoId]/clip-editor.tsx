"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CaptionControls, CAPTION_DEFAULTS, type CaptionConfig } from "./caption-controls";
import { ClipPlayer, type PreviewWord } from "./clip-player";
import { EditableTranscript, type TranscriptRow } from "./editable-transcript";
import { OverlayPanel, type OverlayView } from "./overlay-panel";
import type { WordStyle, WordStylePatch } from "./editable-transcript";
import { SequenceEditor } from "./sequence-editor";
import { ASSET_DND_MIME } from "../media-library";

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
  overlays: serverOverlays,
  wordStyles: serverWordStyles,
  projects,
}: {
  clip: ClipData;
  sourceUrl: string;
  words: PreviewWord[];
  transcript: TranscriptRow[];
  overlays: OverlayView[];
  wordStyles: Record<string, WordStyle>;
  projects: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(clip);
  const [busy, setBusy] = useState<"save" | "render" | "delete" | "thumb" | "save-to" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [dropActive, setDropActive] = useState(false);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const clipLenMs = Math.max(1, clip.endMs - clip.startMs);

  // Overlays are edited optimistically: every move/resize/hide/reorder updates
  // this list instantly and the server write happens in the background (slider
  // drags are coalesced). We only re-seed from the server when the set of
  // overlay ids changes (navigation, or an add/delete we didn't do locally).
  const [overlays, setOverlays] = useState<OverlayView[]>(serverOverlays);
  const serverIds = serverOverlays.map((o) => o.id).join(",");
  const lastSeeded = useRef(serverIds);
  if (serverIds !== lastSeeded.current) {
    lastSeeded.current = serverIds;
    setOverlays(serverOverlays);
  }

  const patchQueue = useRef(new Map<string, Record<string, unknown>>());
  const patchTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const flushPatch = useCallback((id: string) => {
    const body = patchQueue.current.get(id);
    patchQueue.current.delete(id);
    patchTimers.current.delete(id);
    if (!body || Object.keys(body).length === 0) return;
    void fetch(`/api/overlays/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) setOverlayError("couldn't save that change — try again");
      })
      .catch(() => setOverlayError("couldn't save that change — try again"));
  }, []);

  /** Optimistic overlay edit: update the list now, write in the background. */
  const editOverlay = useCallback(
    (id: string, patch: Record<string, unknown>, opts?: { coalesceMs?: number }) => {
      setOverlayError(null);
      setOverlays((list) => list.map((o) => (o.id === id ? { ...o, ...patch } : o)));
      patchQueue.current.set(id, { ...(patchQueue.current.get(id) ?? {}), ...patch });
      clearTimeout(patchTimers.current.get(id));
      const ms = opts?.coalesceMs ?? 0;
      if (ms === 0) flushPatch(id);
      else patchTimers.current.set(id, setTimeout(() => flushPatch(id), ms));
    },
    [flushPatch],
  );

  const reorderOverlayLocal = useCallback((id: string, direction: "up" | "down") => {
    setOverlays((list) => {
      const sorted = [...list].sort((a, b) => a.zIndex - b.zIndex);
      const i = sorted.findIndex((o) => o.id === id);
      const j = direction === "up" ? i + 1 : i - 1;
      if (i === -1 || j < 0 || j >= sorted.length) return list;
      const zi = sorted[i].zIndex;
      const zj = sorted[j].zIndex;
      return list.map((o) =>
        o.id === sorted[i].id ? { ...o, zIndex: zj } : o.id === sorted[j].id ? { ...o, zIndex: zi } : o,
      );
    });
    void fetch(`/api/overlays/${id}/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction }),
    }).catch(() => setOverlayError("couldn't reorder — try again"));
  }, []);

  const deleteOverlayLocal = useCallback((id: string) => {
    setSelectedOverlayId((cur) => (cur === id ? null : cur));
    setOverlays((list) => list.filter((o) => o.id !== id));
    void fetch(`/api/overlays/${id}`, { method: "DELETE" }).catch(() => {
      setOverlayError("couldn't remove that layer — refresh to retry");
    });
  }, []);

  // --- per-word caption styling (the 4th layer: overrides SubtitleConfig for
  // individual words; keyed by word id so text edits keep the styling). ---
  const [wordStyles, setWordStyles] = useState<Record<string, WordStyle>>(serverWordStyles);
  const [selectedWords, setSelectedWords] = useState<Set<string>>(() => new Set());
  const styleKeys = Object.keys(serverWordStyles).sort().join(",");
  const lastStyleKeys = useRef(styleKeys);
  if (styleKeys !== lastStyleKeys.current) {
    lastStyleKeys.current = styleKeys;
    setWordStyles(serverWordStyles);
  }

  const toggleWordSelect = useCallback((id: string) => {
    setSelectedWords((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);
  const clearWordSelection = useCallback(() => setSelectedWords(new Set()), []);

  const applyWordStyle = useCallback((patch: WordStylePatch) => {
    setSelectedWords((sel) => {
      const ids = [...sel];
      if (ids.length === 0) return sel;
      setWordStyles((map) => {
        const next = { ...map };
        for (const id of ids) {
          next[id] = {
            color: patch.color !== undefined ? patch.color : (map[id]?.color ?? null),
            bold: patch.bold !== undefined ? patch.bold : (map[id]?.bold ?? null),
            italic: patch.italic !== undefined ? patch.italic : (map[id]?.italic ?? null),
            sizeScale: patch.sizeScale !== undefined ? patch.sizeScale : (map[id]?.sizeScale ?? null),
          };
        }
        return next;
      });
      void fetch(`/api/clips/${clip.id}/word-styles`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wordIds: ids, style: patch }),
      }).catch(() => setError("couldn't save caption styling — try again"));
      return sel;
    });
  }, [clip.id]);

  const resetWordStyle = useCallback(() => {
    setSelectedWords((sel) => {
      const ids = [...sel];
      if (ids.length === 0) return sel;
      setWordStyles((map) => {
        const next = { ...map };
        for (const id of ids) delete next[id];
        return next;
      });
      void fetch(`/api/clips/${clip.id}/word-styles`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wordIds: ids }),
      }).catch(() => setError("couldn't reset caption styling — try again"));
      return sel;
    });
  }, [clip.id]);
  const [captionsOn, setCaptionsOn] = useState(clip.captions !== null);
  const [captionDraft, setCaptionDraft] = useState<CaptionConfig>(clip.captions ?? CAPTION_DEFAULTS);
  const [saveMenu, setSaveMenu] = useState(false);

  const onCaptionLayout = useCallback(
    (l: { positionY: number; alignment: "left" | "center" | "right" }) =>
      setCaptionDraft((d) => ({ ...d, ...l })),
    [],
  );

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

  async function dropAsset(e: React.DragEvent) {
    e.preventDefault();
    setDropActive(false);
    setOverlayError(null);
    const raw = e.dataTransfer.getData(ASSET_DND_MIME);
    if (!raw) return;
    let payload: { id?: string; kind?: string };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload.id) return;
    if (payload.kind && !["IMAGE", "GIF"].includes(payload.kind)) {
      setOverlayError("Only images and GIFs can be placed on a clip.");
      return;
    }
    try {
      const res = await fetch(`/api/clips/${clip.id}/overlays`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId: payload.id }),
      });
      const created = await res.json().catch(() => null);
      if (!res.ok) throw new Error(created?.error ?? "could not add overlay");
      if (created?.id) {
        setOverlays((list) => [...list, created as OverlayView]);
        setSelectedOverlayId(created.id); // ready to drag into place
      }
    } catch (err) {
      setOverlayError(err instanceof Error ? err.message : "could not add overlay");
    }
  }

  // Delete the selected overlay with the keyboard, unless a field is focused.
  useEffect(() => {
    if (!selectedOverlayId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      e.preventDefault();
      deleteOverlayLocal(selectedOverlayId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOverlayId]);

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
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ASSET_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDropActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false);
      }}
      onDrop={dropAsset}
      className={`card flex flex-col gap-4 p-4 transition-shadow ${
        dropActive ? "ring-2 ring-accent" : ""
      }`}
    >
      {dropActive && (
        <p className="rounded-lg border border-dashed border-accent bg-accent/10 px-3 py-1.5 text-center text-xs text-accent">
          Drop to add this media as an overlay
        </p>
      )}
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
        wordStyles={wordStyles}
        renderUrl={clip.render?.downloadUrl ?? null}
        overlays={overlays}
        selectedOverlayId={selectedOverlayId}
        onSelectOverlay={setSelectedOverlayId}
        onOverlayChange={editOverlay}
        onPlayhead={setPlayheadMs}
        onCaptionLayout={onCaptionLayout}
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

      <OverlayPanel
        overlays={overlays}
        clipLenMs={clipLenMs}
        playheadMs={playheadMs}
        selectedId={selectedOverlayId}
        onSelect={setSelectedOverlayId}
        onEdit={editOverlay}
        onReorder={reorderOverlayLocal}
        onDelete={deleteOverlayLocal}
      />
      {overlayError && <p className="text-sm text-danger">{overlayError}</p>}

      {/* Optional non-linear timeline. Opening it once creates the sequence,
          seeded with this clip's window; a clip with no sequence renders as
          it always has. */}
      <details
        className="group rounded-lg border border-border bg-surface-raised open:pb-3"
        onToggle={(e) => setTimelineOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted marker:content-none hover:text-text">
          <span className="inline-block transition-transform group-open:rotate-90">▸</span> Timeline
          — split &amp; rearrange this clip into pieces
        </summary>
        <div className="px-3">{timelineOpen && <SequenceEditor clipId={clip.id} />}</div>
      </details>

      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted">
          Transcript for this clip — double-click a word to fix a typo, or select words to colour /
          bold them as captions
        </p>
        <EditableTranscript
          rows={transcript}
          styles={wordStyles}
          selectedIds={selectedWords}
          onToggleSelect={toggleWordSelect}
          onApplyStyle={applyWordStyle}
          onReset={resetWordStyle}
          onClearSelection={clearWordSelection}
        />
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
              <a
                href={clip.render.downloadUrl}
                download={`${
                  draft.title
                    .replace(/[^\w\s.-]/g, "")
                    .trim()
                    .replace(/\s+/g, "-")
                    .slice(0, 80) || "clip"
                }.mp4`}
                className="text-accent underline"
              >
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
