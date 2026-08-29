"use client";

/**
 * The clip's non-linear timeline: the standalone <Timeline> component wired to
 * the sequence API. Move / trim are optimistic with a coalesced background
 * PATCH; split and delete round-trip and refetch. A clip with no sequence still
 * renders exactly as before — this panel only appears when the user opens it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Timeline } from "@/components/timeline/Timeline";
import type { TimelineClip, TimelineTrack } from "@/components/timeline/timeline-types";

interface SequenceItemView {
  id: string;
  trackId: string;
  kind: "video" | "audio" | "image";
  name: string;
  timelineStart: number;
  sourceIn: number;
  sourceOut: number;
  sourceDurationMs: number;
  sourceUrl: string | null;
  sourceVideoId: string | null;
  sourceAssetId: string | null;
}
interface SequenceView {
  id: string;
  clipId: string;
  width: number;
  height: number;
  fps: number;
  snap: boolean;
  tracks: Array<{
    id: string;
    index: number;
    kind: "VIDEO" | "AUDIO" | "OVERLAY";
    name: string;
    muted: boolean;
    locked: boolean;
  }>;
  items: SequenceItemView[];
}

/**
 * Overlay items are projected onto the timeline from the `Overlay` table with an
 * `ov_`-prefixed id. Edits to them round-trip to `/api/overlays/:id` (start/end
 * only), not the sequence-item endpoint, and they can't be split.
 */
const isOverlay = (id: string) => id.startsWith("ov_");
const overlayId = (id: string) => id.slice(3);
const OVERLAY_TRACK_PREFIX = "ovtrk_";
const isOverlayTrack = (id: string) => id.startsWith(OVERLAY_TRACK_PREFIX);
const overlayIdFromTrack = (id: string) => id.slice(OVERLAY_TRACK_PREFIX.length);

const itemToClip = (it: SequenceItemView): TimelineClip => ({
  id: it.id,
  trackId: it.trackId,
  name: it.name,
  start: it.timelineStart,
  duration: Math.max(1, it.sourceOut - it.sourceIn),
  sourceIn: it.sourceIn,
  sourceOut: it.sourceOut,
  sourceDuration: it.sourceDurationMs || it.sourceOut,
  // show the actual image for an injected overlay so it's recognisable at a glance
  thumbnails: it.kind === "image" && it.sourceUrl ? [it.sourceUrl] : undefined,
});

const trackToTrack = (t: SequenceView["tracks"][number]): TimelineTrack => ({
  id: t.id,
  label: t.name,
  kind: t.kind.toLowerCase() as TimelineTrack["kind"],
  muted: t.muted,
  locked: t.locked,
});

const TIMECODE = (ms: number) => (Math.max(0, ms) / 1000).toFixed(2);
const parseSec = (s: string): number | null => {
  const n = Number(s.trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
};

export function SequenceEditor({
  clipId,
  followPlayheadMs = null,
  overlayWindows,
  onOverlayTiming,
  onOverlayDeleted,
  onOverlayReorder,
  onChanged,
}: {
  clipId: string;
  /**
   * When the main preview is playing, its position (ms from clip start) is
   * pushed here so the timeline playhead tracks playback. `null` when paused —
   * the timeline then keeps its own playhead and can be scrubbed freely.
   */
  followPlayheadMs?: number | null;
  /**
   * The clip's overlays' current time windows, owned by the editor's Layers
   * panel. Changes here (a "Shows from/to" edit) are reconciled into the
   * timeline; timeline trims/moves of an overlay call {@link onOverlayTiming}
   * back so the Layers panel stays in sync. One source of truth, two views.
   */
  overlayWindows?: Array<{ id: string; startMs: number | null; endMs: number | null }>;
  onOverlayTiming?: (overlayId: string, startMs: number, endMs: number) => void;
  onOverlayDeleted?: (overlayId: string) => void;
  /** Reorder an overlay's layer (its stacking / lane position). */
  onOverlayReorder?: (overlayId: string, direction: "up" | "down") => void;
  /** Called after any change lands server-side, so the editor can soft-refresh. */
  onChanged?: () => void;
}) {
  const [seq, setSeq] = useState<SequenceView | null>(null);
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [save, setSave] = useState<"idle" | "saving" | "saved">("idle");

  // Follow the main preview while it plays. Cheap: one state set per frame the
  // player emits (~30fps), and only while playing.
  useEffect(() => {
    if (followPlayheadMs == null) return;
    setPlayhead(followPlayheadMs);
  }, [followPlayheadMs]);

  // undo / redo — move & trim only; split / delete are structural and reset it.
  const [history, setHistory] = useState<TimelineClip[][]>([]);
  const [future, setFuture] = useState<TimelineClip[][]>([]);

  // per-item coalesced PATCH (move/trim fire many times during a drag)
  const pending = useRef(new Map<string, Record<string, unknown>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Last state we've persisted — the diff base for every PATCH. */
  const serverMirror = useRef<TimelineClip[]>([]);

  const hydrate = useCallback((v: SequenceView) => {
    setSeq(v);
    const mapped = v.items.map(itemToClip);
    setClips(mapped);
    serverMirror.current = mapped;
    setHistory([]);
    setFuture([]);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/sequence`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "could not load timeline");
      hydrate(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load timeline");
    }
  }, [clipId, hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reconcile overlay windows edited elsewhere (the Layers panel) into the
  // timeline. Values the timeline itself just set arrive back unchanged and are
  // no-ops; a genuinely new overlay id triggers an authoritative refetch.
  const overlaySig = (overlayWindows ?? [])
    .map((w) => `${w.id}:${w.startMs ?? ""}:${w.endMs ?? ""}`)
    .join("|");
  useEffect(() => {
    if (!overlayWindows || overlayWindows.length === 0) return;
    setClips((cur) => {
      if (cur.length === 0) return cur;
      const videoEnd =
        cur.filter((c) => !isOverlay(c.id)).reduce((m, c) => Math.max(m, c.start + c.duration), 0) ||
        0;
      const want = new Map(overlayWindows.map((w) => [w.id, w]));
      const haveIds = new Set(
        cur.filter((c) => isOverlay(c.id)).map((c) => overlayId(c.id)),
      );
      if (overlayWindows.some((w) => !haveIds.has(w.id))) {
        void load(); // an overlay was added elsewhere — refetch for its name/url
        return cur;
      }
      let changed = false;
      const next = cur.map((c) => {
        if (!isOverlay(c.id)) return c;
        const w = want.get(overlayId(c.id));
        if (!w) return c;
        const start = Math.max(0, w.startMs ?? 0);
        const end = Math.max(start + 1, w.endMs ?? (videoEnd || c.sourceDuration));
        if (Math.round(c.start) === start && Math.round(c.start + c.duration) === end) return c;
        changed = true;
        return { ...c, start, duration: end - start, sourceIn: 0, sourceOut: end - start };
      });
      if (!changed) return cur;
      serverMirror.current = next; // these values are already persisted — don't echo a PATCH
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlaySig]);

  const flush = useCallback((id: string) => {
    const body = pending.current.get(id);
    pending.current.delete(id);
    timers.current.delete(id);
    if (!body || Object.keys(body).length === 0) return;
    setSave("saving");
    const url = isOverlay(id) ? `/api/overlays/${overlayId(id)}` : `/api/sequence-items/${id}`;
    void fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        setSave("saved");
        setTimeout(() => setSave("idle"), 1500);
        onChanged?.();
      })
      .catch(() => setError("a change didn't save — try again"));
  }, [onChanged]);

  /** Diff `next` against what's persisted and fire a coalesced PATCH per item. */
  const persist = useCallback(
    (next: TimelineClip[]) => {
      const base = new Map(serverMirror.current.map((c) => [c.id, c]));
      // clip length = furthest end of the real (video) items — used to clamp
      // overlay windows so the overlay PATCH never 422s.
      const clipLenMs = Math.max(
        1000,
        next.filter((c) => !isOverlay(c.id)).reduce((m, c) => Math.max(m, c.start + c.duration), 0),
      );
      for (const nc of next) {
        const oc = base.get(nc.id);
        if (!oc) continue; // new items are created via their own endpoint

        if (isOverlay(nc.id)) {
          const moved =
            nc.start !== oc.start || nc.duration !== oc.duration || nc.sourceOut !== oc.sourceOut;
          if (!moved) continue;
          const startMs = Math.min(Math.max(0, Math.round(nc.start)), clipLenMs - 200);
          const endMs = Math.min(
            Math.max(startMs + 200, Math.round(nc.start + nc.duration)),
            clipLenMs,
          );
          pending.current.set(nc.id, { startMs, endMs });
          clearTimeout(timers.current.get(nc.id));
          timers.current.set(nc.id, setTimeout(() => flush(nc.id), 250));
          onOverlayTiming?.(overlayId(nc.id), startMs, endMs);
          continue;
        }

        const patch: Record<string, unknown> = {};
        if (nc.start !== oc.start) patch.timelineStart = Math.round(nc.start);
        if (nc.sourceIn !== oc.sourceIn) patch.sourceIn = Math.round(nc.sourceIn);
        if (nc.sourceOut !== oc.sourceOut) patch.sourceOut = Math.round(nc.sourceOut);
        if (nc.trackId !== oc.trackId) patch.trackId = nc.trackId;
        if (Object.keys(patch).length === 0) continue;
        pending.current.set(nc.id, { ...(pending.current.get(nc.id) ?? {}), ...patch });
        clearTimeout(timers.current.get(nc.id));
        timers.current.set(nc.id, setTimeout(() => flush(nc.id), 250));
      }
      serverMirror.current = next;
    },
    [flush, onOverlayTiming],
  );

  /** The component hands us the whole array on any move / trim / delete. */
  const onClipsChange = useCallback(
    (next: TimelineClip[]) => {
      const nextIds = new Set(next.map((c) => c.id));
      const removed = clips.filter((c) => !nextIds.has(c.id));

      if (removed.length === 0) {
        // move / trim -> undoable
        setHistory((h) => [...h.slice(-49), clips]);
        setFuture([]);
      } else {
        // structural -> reset history and delete server-side
        setHistory([]);
        setFuture([]);
        for (const c of removed) {
          setSave("saving");
          if (isOverlay(c.id)) onOverlayDeleted?.(overlayId(c.id));
          const url = isOverlay(c.id)
            ? `/api/overlays/${overlayId(c.id)}`
            : `/api/sequence-items/${c.id}`;
          void fetch(url, { method: "DELETE" })
            .then((r) => {
              setSave(r.ok ? "saved" : "idle");
              if (r.ok) {
                setTimeout(() => setSave("idle"), 1500);
                onChanged?.();
              }
            })
            .catch(() => setError("delete didn't save"));
        }
      }

      setClips(next);
      persist(next);
    },
    [clips, persist, onOverlayDeleted, onChanged],
  );

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setFuture((f) => [clips, ...f]);
      setClips(prev);
      persist(prev);
      return h.slice(0, -1);
    });
  }, [clips, persist]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const nextState = f[0];
      setHistory((h) => [...h, clips]);
      setClips(nextState);
      persist(nextState);
      return f.slice(1);
    });
  }, [clips, persist]);

  /** Apply one field change to the selected item through the same path as a drag. */
  const editSelected = useCallback(
    (patch: Partial<TimelineClip>) => {
      if (!selected) return;
      onClipsChange(clips.map((c) => (c.id === selected ? { ...c, ...patch } : c)));
    },
    [clips, onClipsChange, selected],
  );

  const onSplit = useCallback(
    async (id: string, atMs: number) => {
      if (isOverlay(id)) {
        setError("Overlays can't be split — drag their ends to re-time them.");
        return;
      }
      setSave("saving");
      try {
        const res = await fetch(`/api/sequence-items/${id}/split`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ atMs }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "split failed");
        await load(); // authoritative — new item has a server id
        setSave("saved");
        setTimeout(() => setSave("idle"), 1500);
        onChanged?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "split failed");
        setSave("idle");
      }
    },
    [load, onChanged],
  );

  const onSnapChange = useCallback(
    (on: boolean) => {
      if (!seq) return;
      setSeq({ ...seq, snap: on });
      void fetch(`/api/sequences/${seq.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snap: on }),
      }).catch(() => setError("snap setting didn't save"));
    },
    [seq],
  );

  /** ▲▼ on an overlay lane header — swap it with its neighbour lane. The write
   *  goes through the editor (which owns the Layers panel + the /reorder call). */
  const onReorderTrack = useCallback(
    (trackId: string, direction: "up" | "down") => {
      if (!isOverlayTrack(trackId)) return;
      setSeq((s) => {
        if (!s) return s;
        const t = [...s.tracks];
        const i = t.findIndex((x) => x.id === trackId);
        const j = direction === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= t.length || t[j].kind !== "OVERLAY") return s;
        [t[i], t[j]] = [t[j], t[i]];
        return { ...s, tracks: t };
      });
      onOverlayReorder?.(overlayIdFromTrack(trackId), direction);
    },
    [onOverlayReorder],
  );

  if (error && !seq) {
    return (
      <div className="rounded-lg border border-danger/40 bg-surface-raised p-3 text-sm text-danger">
        {error} <button onClick={() => void load()} className="ml-2 underline">retry</button>
      </div>
    );
  }
  if (!seq) {
    return <div className="rounded-lg border border-border bg-surface-raised p-4 text-sm text-muted">Loading timeline…</div>;
  }

  const contentEnd = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const sel = clips.find((c) => c.id === selected) ?? null;
  // Grow with the track count (video + one lane per overlay) so every overlay
  // lane stays visible; cap it so a clip with many overlays still fits.
  const tlHeight = Math.min(620, 150 + seq.tracks.length * 84);

  return (
    <div className="flex flex-col gap-1.5">
      <div style={{ height: tlHeight }}>
      <Timeline
        className="h-full"
        tracks={seq.tracks.map(trackToTrack)}
        clips={clips}
        onClipsChange={onClipsChange}
        playheadMs={playhead}
        onSeek={setPlayhead}
        durationMs={Math.max(contentEnd + 4000, 12000)}
        selectedClipId={selected}
        onSelectClip={setSelected}
        snap={seq.snap}
        onSnapChange={onSnapChange}
        onReorderTrack={onReorderTrack}
        onSplit={(id, atMs) => void onSplit(id, atMs)}
        onUndo={undo}
        onRedo={redo}
        canUndo={history.length > 0}
        canRedo={future.length > 0}
        saveState={save}
      />
      </div>

      {/* precise numeric editing for the selected item (§11) */}
      {sel && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs">
          <span className="min-w-0 max-w-[40%] truncate font-medium" title={sel.name}>
            {sel.name}
          </span>
          <NumField
            label="Start"
            value={sel.start}
            onCommit={(ms) => editSelected({ start: ms })}
          />
          <NumField
            label="End"
            value={sel.start + sel.duration}
            onCommit={(ms) =>
              editSelected({ duration: Math.max(100, ms - sel.start), sourceOut: sel.sourceIn + Math.max(100, ms - sel.start) })
            }
          />
          <NumField
            label="Duration"
            value={sel.duration}
            onCommit={(ms) =>
              editSelected({ duration: Math.max(100, ms), sourceOut: sel.sourceIn + Math.max(100, ms) })
            }
          />
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
      <p className="text-[11px] text-muted">
        Output {seq.width}×{seq.height} · {seq.fps}fps · drag to move, drag an edge to trim, S to
        split at the playhead, Del to remove, ⌘Z to undo. The <span className="text-fg">Overlays</span>{" "}
        track shows every image / GIF injected onto this clip — drag it to re-time or trim it here.
        Non-destructive — the source clip is untouched.
      </p>
    </div>
  );
}

function NumField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (ms: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <input
        type="number"
        min={0}
        step={0.01}
        defaultValue={TIMECODE(value)}
        key={`${label}-${value}`}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          const ms = parseSec(e.target.value);
          if (ms != null && ms !== value) onCommit(ms);
        }}
        className="field w-20 font-mono tabular-nums"
      />
      <span className="text-muted">s</span>
    </label>
  );
}
