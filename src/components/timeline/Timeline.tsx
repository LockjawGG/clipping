"use client";

/**
 * A CapCut-flavoured editing timeline.
 *
 *  - Dark, elevated surfaces; Inter/SF-style type.
 *  - Ruler with adaptive time ticks + a draggable, soft-shadowed playhead.
 *  - Tracks with a left gutter (V1 / A1 …) whose mute / solo / lock reveal on hover.
 *  - Clips as rounded cards: filmstrip, accent bar, name · resolution · fps · duration.
 *  - Drag the body to move, drag an edge to trim; live tooltips + snap guides.
 *  - Wheel + ⌘/Ctrl zooms around the cursor; plain wheel scrolls.
 *  - Space = play/pause, ← / → = nudge, Delete = remove selected.
 *
 * Self-contained: no router, no data fetching, no app imports. Drive it with
 * `clips` + `onClipsChange`, or run it uncontrolled.
 *
 * See `timeline-demo` for a usage example.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type {
  TimelineClip,
  TimelineProps,
  TimelineTrack,
  TrackKind,
} from "./timeline-types";

/* ------------------------------------------------------------------ palette */

const C = {
  bg: "#0F0F0F",
  surface: "#161616",
  surfaceRaised: "#1E1E1E",
  border: "#2A2A2A",
  borderStrong: "#3A3A3A",
  text: "#F2F2F2",
  muted: "#8A8A8A",
  accent: "#4FD1C5", // teal — selection + playhead
} as const;

const ACCENT_BY_KIND: Record<TrackKind, string> = {
  video: "#4FD1C5",
  audio: "#F6A94A",
  overlay: "#B085F5",
  text: "#5B9DF9",
};

/* ------------------------------------------------------------------- config */

const GUTTER_W = 96; // left track-header column
const RULER_H = 34;
const TRACK_H = 68;
const TRACK_GAP = 8;
const BASE_PPS = 10; // px per second at zoom = 1
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 12;
const MIN_CLIP_MS = 200;
const SNAP_PX = 7;

/* --------------------------------------------------------------- utilities */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** `mm:ss.ff` (ff = frames, assuming 30fps for the readout) or `mm:ss` when coarse. */
function fmt(ms: number, frames = false) {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  if (!frames) return base;
  const ff = Math.floor(((t % 1000) / 1000) * 30);
  return `${base}.${String(ff).padStart(2, "0")}`;
}

/** A "nice" tick spacing (seconds) so labels never crowd. */
function tickSeconds(pxPerSec: number) {
  const targetPx = 84;
  const raw = targetPx / pxPerSec;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s >= raw) ?? 900;
}

/** Standard controlled/uncontrolled state. */
function useControllable<T>(value: T | undefined, onChange: ((v: T) => void) | undefined, fallback: T) {
  const [inner, setInner] = useState<T>(value ?? fallback);
  const isControlled = value !== undefined && onChange !== undefined;
  const current = isControlled ? (value as T) : inner;
  const set = useCallback(
    (next: T) => {
      if (isControlled) onChange!(next);
      else setInner(next);
    },
    [isControlled, onChange],
  );
  // keep the uncontrolled copy in sync if the seed prop identity changes
  useEffect(() => {
    if (!isControlled && value !== undefined) setInner(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return [current, set] as const;
}

/* ================================================================ Timeline */

type DragMode = "move" | "trim-l" | "trim-r";
interface DragState {
  clipId: string;
  mode: DragMode;
  startX: number;
  dxPx: number;
  raf: number;
  /** The lane the pointer is currently over, for a move that crosses layers. */
  overTrackId?: string;
}

export function Timeline({
  tracks,
  clips: clipsProp,
  onClipsChange,
  onTracksChange,
  onReorderTrack,
  onRemoveTrack,
  playheadMs,
  onSeek,
  durationMs,
  selectedClipId,
  onSelectClip,
  playing = false,
  onTogglePlay,
  snap: snapProp,
  onSnapChange,
  onSplit,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  saveState = "idle",
  onImport,
  className,
}: TimelineProps) {
  const [clips, setClips] = useControllable(clipsProp, onClipsChange, clipsProp);
  const [playhead, setPlayhead] = useControllable(playheadMs, onSeek, 0);
  const [selected, setSelected] = useControllable(
    selectedClipId ?? undefined,
    onSelectClip,
    null as string | null,
  );
  const [snap, setSnap] = useControllable(snapProp, onSnapChange, true);

  const [zoom, setZoom] = useState(1);
  const pxPerSec = BASE_PPS * zoom;
  const msToX = useCallback((ms: number) => (ms / 1000) * pxPerSec, [pxPerSec]);
  const xToMs = useCallback((x: number) => (x / pxPerSec) * 1000, [pxPerSec]);

  const total = useMemo(() => {
    if (durationMs) return durationMs;
    const end = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    return Math.max(end + 5000, 15000);
  }, [clips, durationMs]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  /**
   * Live rects for the lane rows, so a vertical drag can say which lane the
   * pointer is over. Measured rather than derived from TRACK_H: the row heights
   * are laid out by flexbox, and duplicating that arithmetic here would drift
   * the moment the layout changes.
   */
  const trackRows = useRef(new Map<string, HTMLDivElement>());
  const trackAtY = useCallback((clientY: number): string | null => {
    let nearest: { id: string; distance: number } | null = null;
    for (const [id, el] of trackRows.current) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return id;
      // Outside every row (the gaps, or past the ends) the nearest lane is what
      // the user is reaching for — dropping into a gap should not be a no-op.
      const distance = clientY < r.top ? r.top - clientY : clientY - r.bottom;
      if (!nearest || distance < nearest.distance) nearest = { id, distance };
    }
    return nearest?.id ?? null;
  }, []);
  const [snapX, setSnapX] = useState<number | null>(null);
  const [dropActive, setDropActive] = useState(false);

  /* -------------------------------------------------- clip mutation helpers */

  const patchClip = useCallback(
    (id: string, patch: Partial<TimelineClip>) =>
      setClips(clips.map((c) => (c.id === id ? { ...c, ...patch } : c))),
    [clips, setClips],
  );
  const removeClip = useCallback(
    (id: string) => {
      setClips(clips.filter((c) => c.id !== id));
      if (selected === id) setSelected(null);
    },
    [clips, selected, setClips, setSelected],
  );

  /* --------------------------------------------------------- snapping model */

  /** Candidate x positions the dragged edge can snap to (playhead, clip edges, 0). */
  const snapTargets = useCallback(
    (excludeId: string) => {
      const xs = [0, msToX(playhead)];
      for (const c of clips) {
        if (c.id === excludeId) continue;
        xs.push(msToX(c.start), msToX(c.start + c.duration));
      }
      return xs;
    },
    [clips, msToX, playhead],
  );

  /** Snap `edgeX` to the nearest target within SNAP_PX; returns the adjusted
   *  delta. A no-op (free positioning) when snapping is toggled off. */
  const applySnap = useCallback(
    (edgeX: number, rawDx: number, excludeId: string) => {
      if (!snap) {
        setSnapX(null);
        return rawDx;
      }
      let best: number | null = null;
      let bestDist = SNAP_PX;
      for (const t of snapTargets(excludeId)) {
        const d = Math.abs(edgeX - t);
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }
      if (best === null) {
        setSnapX(null);
        return rawDx;
      }
      setSnapX(best);
      return rawDx + (best - edgeX);
    },
    [snap, snapTargets],
  );

  /* ------------------------------------------------------ clip drag / trim */

  const paint = useCallback(() => {
    setDrag((d) => (d ? { ...d } : d)); // force a re-render at frame rate
  }, []);

  const onClipPointerDown = useCallback(
    (e: ReactPointerEvent, clip: TimelineClip, mode: DragMode) => {
      const track = tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setSelected(clip.id);
      setDrag({ clipId: clip.id, mode, startX: e.clientX, dxPx: 0, raf: 0, overTrackId: clip.trackId });
    },
    [setSelected, tracks],
  );

  const onClipPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      setDrag((d) => {
        if (!d) return d;
        const clip = clips.find((c) => c.id === d.clipId);
        if (!clip) return d;
        let dx = e.clientX - d.startX;
        // snap the moving edge
        const edgeX =
          d.mode === "trim-r"
            ? msToX(clip.start + clip.duration) + dx
            : msToX(clip.start) + dx;
        dx = applySnap(edgeX, dx, clip.id);
        if (!d.raf) d.raf = requestAnimationFrame(paint);
        // Only a move changes lanes; trimming an edge stays where it is.
        const overTrackId = d.mode === "move" ? (trackAtY(e.clientY) ?? d.overTrackId) : d.overTrackId;
        return { ...d, dxPx: dx, overTrackId };
      });
    },
    [applySnap, clips, msToX, paint, trackAtY],
  );

  const commitDrag = useCallback(() => {
    setDrag((d) => {
      if (!d) return null;
      if (d.raf) cancelAnimationFrame(d.raf);
      const clip = clips.find((c) => c.id === d.clipId);
      if (!clip) return null;
      const deltaMs = xToMs(d.dxPx);

      if (d.mode === "move") {
        // A move can cross lanes as well as slide along one.
        const trackId = d.overTrackId && d.overTrackId !== clip.trackId ? d.overTrackId : undefined;
        patchClip(clip.id, {
          start: Math.max(0, Math.round(clip.start + deltaMs)),
          ...(trackId ? { trackId } : {}),
        });
      } else if (d.mode === "trim-l") {
        const maxLeft = clip.duration - MIN_CLIP_MS; // can't cross the right edge
        const minLeft = Math.max(
          -clip.sourceIn, // can't expose media before sourceIn
          -clip.start, // ...and a piece cannot begin before the timeline does
        );
        const shift = clamp(deltaMs, minLeft, maxLeft);
        patchClip(clip.id, {
          start: Math.round(clip.start + shift),
          sourceIn: Math.round(clip.sourceIn + shift),
          duration: Math.round(clip.duration - shift),
        });
      } else {
        const maxRight = clip.sourceDuration - clip.sourceOut; // media left on the tail
        const minRight = MIN_CLIP_MS - clip.duration;
        const grow = clamp(deltaMs, minRight, maxRight);
        patchClip(clip.id, {
          duration: Math.round(clip.duration + grow),
          sourceOut: Math.round(clip.sourceOut + grow),
        });
      }
      setSnapX(null);
      return null;
    });
  }, [clips, patchClip, xToMs]);

  /* --------------------------------------------------------- playhead drag */

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left + el.scrollLeft - GUTTER_W;
      setPlayhead(clamp(Math.round(xToMs(x)), 0, total));
    },
    [setPlayhead, total, xToMs],
  );

  const [scrubbing, setScrubbing] = useState(false);
  const onRulerPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setScrubbing(true);
      seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );

  /* ---------------------------------------------------------------- zoom */

  const zoomAnchor = useRef<{ time: number; clientX: number } | null>(null);
  const onWheel = useCallback(
    (e: ReactWheelEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const localX = e.clientX - rect.left - GUTTER_W + el.scrollLeft;
        zoomAnchor.current = { time: xToMs(localX), clientX: e.clientX - rect.left - GUTTER_W };
        setZoom((z) => clamp(z * Math.exp(-e.deltaY * 0.0016), MIN_ZOOM, MAX_ZOOM));
      } else {
        el.scrollLeft += e.deltaY + e.deltaX;
      }
    },
    [xToMs],
  );

  // keep the anchored time under the cursor after a zoom change
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = zoomAnchor.current;
    if (!el || !a) return;
    el.scrollLeft = (a.time / 1000) * pxPerSec - a.clientX;
    zoomAnchor.current = null;
  }, [pxPerSec]);

  /* ------------------------------------------------------- global pointer */

  useEffect(() => {
    if (!drag && !scrubbing) return;
    const move = (e: PointerEvent) => {
      if (drag) onClipPointerMove(e as unknown as ReactPointerEvent);
      if (scrubbing) seekFromClientX(e.clientX);
    };
    const up = () => {
      if (drag) commitDrag();
      setScrubbing(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, scrubbing, onClipPointerMove, seekFromClientX, commitDrag]);

  /* ------------------------------------------------------------ keyboard */

  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * The piece Split would act on.
   *
   * A selection wins, because picking a piece is an explicit statement about
   * which one you mean. With nothing selected it is simply whatever sits under
   * the playhead, which is what the button looks like it should do — requiring
   * a selection first made it a button that did nothing for no visible reason.
   *
   * Only a piece the playhead is strictly inside counts: splitting on a
   * boundary would produce a zero-length piece. When several lanes have one
   * there the base lane wins — it is the lane that decides how long the export
   * is, and an upper lane can still be split by clicking it first.
   */
  const splitTarget = useMemo(() => {
    const inside = (c: TimelineClip) =>
      playhead > c.start + 1 && playhead < c.start + c.duration - 1;
    if (selected) {
      const c = clips.find((x) => x.id === selected);
      return c && inside(c) ? c : null;
    }
    const lane = new Map(tracks.map((t, i) => [t.id, i]));
    return (
      [...clips]
        .filter(inside)
        .sort((a, b) => (lane.get(a.trackId) ?? 0) - (lane.get(b.trackId) ?? 0))[0] ?? null
    );
  }, [clips, playhead, selected, tracks]);

  /** Handled here and by the toolbar button. */
  const splitAtPlayhead = useCallback(() => {
    if (!onSplit || !splitTarget) return;
    onSplit(splitTarget.id, Math.round(playhead));
  }, [onSplit, playhead, splitTarget]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      const frame = e.shiftKey ? 1000 : 1000 / 30;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.code === "KeyZ") {
        e.preventDefault();
        (e.shiftKey ? onRedo : onUndo)?.();
      } else if (e.code === "Space") {
        e.preventDefault();
        onTogglePlay?.();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        setPlayhead(clamp(Math.round(playhead - frame), 0, total));
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        setPlayhead(clamp(Math.round(playhead + frame), 0, total));
      } else if (e.code === "KeyS" && !mod) {
        e.preventDefault();
        splitAtPlayhead();
      } else if ((e.code === "Delete" || e.code === "Backspace") && selected) {
        e.preventDefault();
        removeClip(selected);
      }
    },
    [onRedo, onTogglePlay, onUndo, playhead, removeClip, selected, setPlayhead, splitAtPlayhead, total],
  );

  /* ---------------------------------------------------------------- drop */

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropActive(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length) onImport?.(files);
    },
    [onImport],
  );

  /* --------------------------------------------------------------- render */

  const contentW = Math.max(msToX(total), 600);
  const tickS = tickSeconds(pxPerSec);
  const ticks: number[] = [];
  for (let s = 0; s * 1000 <= total; s += tickS) ticks.push(s);

  const isEmpty = clips.length === 0;

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={`flex flex-col overflow-hidden rounded-xl outline-none ${className ?? ""}`}
      style={{
        background: C.bg,
        border: `1px solid ${C.border}`,
        color: C.text,
        fontFamily:
          'Inter, ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif',
      }}
    >
      {/* toolbar */}
      <div
        className="flex items-center gap-3 px-3 py-2 text-xs"
        style={{ borderBottom: `1px solid ${C.border}`, background: C.surface }}
      >
        <button
          onClick={onTogglePlay}
          className="grid h-7 w-7 place-items-center rounded-md transition-colors"
          style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span style={{ color: C.muted }} className="tabular-nums">
          {fmt(playhead, true)} <span style={{ opacity: 0.5 }}>/ {fmt(total)}</span>
        </span>

        {/* edit actions — Undo | Redo | Split | Delete | Snap  (§15) */}
        <div className="ml-3 flex items-center gap-1">
          {(onUndo || onRedo) && (
            <>
              <TBtn label="Undo (⌘Z)" disabled={!canUndo} onClick={() => onUndo?.()}>
                ↺
              </TBtn>
              <TBtn label="Redo (⌘⇧Z)" disabled={!canRedo} onClick={() => onRedo?.()}>
                ↻
              </TBtn>
              <span style={{ width: 1, height: 16, background: C.border }} />
            </>
          )}
          {onSplit && (
            <TBtn
              label={
                splitTarget
                  ? `Split ${splitTarget.name} at the playhead (S)`
                  : selected
                    ? "Split (S) — the playhead is not inside the selected piece"
                    : "Split (S) — move the playhead over a piece"
              }
              disabled={!splitTarget}
              onClick={splitAtPlayhead}
            >
              ✂
            </TBtn>
          )}
          <TBtn label="Delete selected (Del)" disabled={!selected} onClick={() => selected && removeClip(selected)}>
            🗑
          </TBtn>
          <TBtn label={`Snap ${snap ? "on" : "off"}`} active={snap} onClick={() => setSnap(!snap)}>
            🧲
          </TBtn>
        </div>

        {saveState !== "idle" && (
          <span
            className="ml-2 text-[11px] transition-opacity"
            style={{ color: saveState === "saved" ? C.accent : C.muted }}
          >
            {saveState === "saving" ? "Saving…" : "✓ Saved"}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <TBtn label="Fit timeline" onClick={() => setZoom(1)}>
            ⤢
          </TBtn>
          <button
            onClick={() => setZoom((z) => clamp(z / 1.4, MIN_ZOOM, MAX_ZOOM))}
            className="h-7 w-7 rounded-md"
            style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}
            aria-label="Zoom out"
          >
            −
          </button>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-28 accent-current"
            style={{ accentColor: C.accent }}
            aria-label="Zoom"
          />
          <button
            onClick={() => setZoom((z) => clamp(z * 1.4, MIN_ZOOM, MAX_ZOOM))}
            className="h-7 w-7 rounded-md"
            style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* left gutter — track headers */}
        <div
          className="flex shrink-0 flex-col"
          style={{ width: GUTTER_W, background: C.surface, borderRight: `1px solid ${C.border}` }}
        >
          <div style={{ height: RULER_H, borderBottom: `1px solid ${C.border}` }} />
          <div className="flex flex-col gap-2 p-2">
            {tracks.map((t) => {
              const isLane = (k: TrackKind) => k === "overlay" || k === "text";
              const overlayIdxs = tracks.reduce<number[]>((a, x, i) => {
                if (isLane(x.kind)) a.push(i);
                return a;
              }, []);
              const pos = overlayIdxs.indexOf(tracks.indexOf(t));
              const reorderable = onReorderTrack && isLane(t.kind) && overlayIdxs.length > 1;
              return (
                <TrackHeader
                  key={t.id}
                  track={t}
                  onChange={(patch) =>
                    onTracksChange?.(tracks.map((x) => (x.id === t.id ? { ...x, ...patch } : x)))
                  }
                  onReorder={reorderable ? (dir) => onReorderTrack!(t.id, dir) : undefined}
                  canUp={pos > 0}
                  canDown={pos >= 0 && pos < overlayIdxs.length - 1}
                  onRemove={
                    // Only an empty video lane, and never the last one — the
                    // control is absent rather than disabled, so there is no
                    // button that looks like it would throw work away.
                    onRemoveTrack &&
                    t.kind === "video" &&
                    tracks.filter((x) => x.kind === "video").length > 1 &&
                    !clips.some((c) => c.trackId === t.id)
                      ? () => onRemoveTrack(t.id)
                      : undefined
                  }
                />
              );
            })}
          </div>
        </div>

        {/* scrollable timeline */}
        <div
          ref={scrollRef}
          onWheel={onWheel}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDropActive(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDropActive(false);
          }}
          onDrop={handleDrop}
          className="relative min-w-0 flex-1 overflow-x-auto overflow-y-auto"
        >
          <div style={{ width: contentW, position: "relative" }}>
            {/* ruler */}
            <div
              onPointerDown={onRulerPointerDown}
              className="sticky top-0 z-20 cursor-text select-none"
              style={{ height: RULER_H, background: C.surface, borderBottom: `1px solid ${C.border}` }}
            >
              {ticks.map((s) => (
                <div
                  key={s}
                  className="absolute top-0 flex h-full flex-col justify-end pb-1"
                  style={{ left: msToX(s * 1000) }}
                >
                  <div style={{ width: 1, height: 8, background: C.borderStrong }} />
                  <span
                    className="absolute left-1 top-1 text-[10px] tabular-nums"
                    style={{ color: C.muted }}
                  >
                    {fmt(s * 1000)}
                  </span>
                </div>
              ))}
            </div>

            {/* tracks */}
            <div className="relative p-2" style={{ display: "flex", flexDirection: "column", gap: TRACK_GAP }}>
              {tracks.map((track) => (
                <div
                  key={track.id}
                  ref={(el) => {
                    if (el) trackRows.current.set(track.id, el);
                    else trackRows.current.delete(track.id);
                  }}
                  className="relative rounded-lg"
                  style={{
                    height: TRACK_H,
                    background: C.surface,
                    // The lane a dragged piece would land in is outlined, so a
                    // cross-lane drop is visible before the pointer is released.
                    border:
                      drag?.mode === "move" && drag.overTrackId === track.id
                        ? `1px solid ${C.accent}`
                        : `1px solid ${C.border}`,
                    opacity: track.locked ? 0.65 : 1,
                  }}
                >
                  {clips
                    .filter((c) => c.trackId === track.id)
                    .map((clip) => (
                      <ClipView
                        key={clip.id}
                        clip={clip}
                        track={track}
                        selected={selected === clip.id}
                        drag={drag?.clipId === clip.id ? drag : null}
                        msToX={msToX}
                        onSelect={() => setSelected(clip.id)}
                        onPointerDown={onClipPointerDown}
                      />
                    ))}
                </div>
              ))}

              {isEmpty && (
                <button
                  onClick={() => onImport?.([])}
                  className="grid place-items-center rounded-lg text-sm transition-colors"
                  style={{
                    height: TRACK_H,
                    border: `1.5px dashed ${dropActive ? C.accent : C.borderStrong}`,
                    background: dropActive ? "rgba(79,209,197,0.08)" : "transparent",
                    color: C.muted,
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-lg">⤓</span> Drop media here or click to import
                  </span>
                </button>
              )}
            </div>

            {/* snap guide */}
            {snapX !== null && (
              <div
                className="pointer-events-none absolute top-0 z-30"
                style={{ left: snapX, width: 1, height: "100%", background: C.accent, opacity: 0.7 }}
              />
            )}

            {/* playhead */}
            <div
              className="pointer-events-none absolute top-0 z-40"
              style={{ left: msToX(playhead), height: "100%" }}
            >
              <div
                className="pointer-events-auto -ml-[6px] h-3 w-3 cursor-ew-resize rounded-full"
                style={{ background: C.accent, boxShadow: "0 1px 6px rgba(0,0,0,0.6)" }}
                onPointerDown={onRulerPointerDown}
              />
              <div
                style={{
                  width: 1.5,
                  height: "100%",
                  marginLeft: -0.75,
                  background: "#FFFFFF",
                  boxShadow: "0 0 8px rgba(0,0,0,0.8)",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- toolbar */

function TBtn({
  children,
  label,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-[13px] transition-colors disabled:opacity-30"
      style={{
        background: active ? C.accent : C.surfaceRaised,
        color: active ? C.bg : C.text,
        border: `1px solid ${C.border}`,
      }}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------ TrackHeader */

function TrackHeader({
  track,
  onChange,
  onReorder,
  canUp,
  canDown,
  onRemove,
}: {
  track: TimelineTrack;
  onChange: (patch: Partial<TimelineTrack>) => void;
  /** Present only for reorderable (overlay) lanes. */
  onReorder?: (direction: "up" | "down") => void;
  canUp?: boolean;
  canDown?: boolean;
  /** Present only for a lane that can actually go: empty, and not the last. */
  onRemove?: () => void;
}) {
  const dot = ACCENT_BY_KIND[track.kind];
  return (
    <div
      className="group flex h-[68px] flex-col justify-between rounded-lg p-2 text-xs"
      style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}
    >
      <div className="flex items-center gap-1.5">
        <span style={{ width: 6, height: 6, borderRadius: 999, background: dot }} />
        <span className="min-w-0 flex-1 truncate font-semibold" title={track.label}>
          {track.label}
        </span>
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${track.label}`}
            title="Remove this empty layer"
            onClick={onRemove}
            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            style={{ color: C.muted }}
          >
            ✕
          </button>
        )}
        {onReorder && (
          <span className="flex shrink-0 flex-col leading-none opacity-0 transition-opacity group-hover:opacity-100">
            {(["up", "down"] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                aria-label={dir === "up" ? "Bring layer forward" : "Send layer back"}
                disabled={dir === "up" ? !canUp : !canDown}
                onClick={() => onReorder(dir)}
                className="grid h-3 w-4 place-items-center text-[9px] disabled:opacity-25"
                style={{ color: C.muted }}
              >
                {dir === "up" ? "▲" : "▼"}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {(
          [
            ["muted", "M", track.muted],
            ["solo", "S", track.solo],
            ["locked", "L", track.locked],
          ] as const
        ).map(([key, glyph, on]) => (
          <button
            key={key}
            onClick={() => onChange({ [key]: !on })}
            aria-pressed={!!on}
            className="grid h-5 w-5 place-items-center rounded text-[10px] font-bold transition-colors"
            style={{
              background: on ? C.accent : C.surface,
              color: on ? C.bg : C.muted,
              border: `1px solid ${C.border}`,
            }}
          >
            {glyph}
          </button>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- ClipView */

function ClipView({
  clip,
  track,
  selected,
  drag,
  msToX,
  onSelect,
  onPointerDown,
}: {
  clip: TimelineClip;
  track: TimelineTrack;
  selected: boolean;
  drag: DragState | null;
  msToX: (ms: number) => number;
  onSelect: () => void;
  onPointerDown: (e: ReactPointerEvent, clip: TimelineClip, mode: DragMode) => void;
}) {
  const [hover, setHover] = useState(false);

  // geometry, adjusted live while dragging this clip
  let left = msToX(clip.start);
  let width = msToX(clip.duration);
  if (drag) {
    if (drag.mode === "move") left += drag.dxPx;
    else if (drag.mode === "trim-l") {
      left += drag.dxPx;
      width -= drag.dxPx;
    } else width += drag.dxPx;
  }
  width = Math.max(width, 12);
  left = Math.max(left, 0);

  const accent = clip.accent ?? ACCENT_BY_KIND[track.kind];
  const showHandles = (hover || selected) && !track.locked;

  const meta = [
    clip.width && clip.height ? `${clip.width}×${clip.height}` : null,
    clip.fps ? `${clip.fps}fps` : null,
    fmt(clip.duration, true),
  ]
    .filter(Boolean)
    .join("  ·  ");

  const frameStyle: CSSProperties = {
    position: "absolute",
    left,
    width,
    top: 4,
    bottom: 4,
    borderRadius: 10,
    overflow: "hidden",
    background: C.surfaceRaised,
    border: `1px solid ${selected ? accent : C.borderStrong}`,
    boxShadow: selected
      ? `0 0 0 1px ${accent}, 0 6px 20px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04)`
      : "0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03)",
    transition: drag ? "none" : "left 140ms cubic-bezier(.2,.8,.2,1), width 140ms cubic-bezier(.2,.8,.2,1), box-shadow 140ms",
    cursor: track.locked ? "not-allowed" : "grab",
  };

  return (
    <div
      style={frameStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onPointerDown={(e) => onPointerDown(e, clip, "move")}
      onClick={onSelect}
    >
      {/* filmstrip / poster */}
      <Filmstrip thumbnails={clip.thumbnails} accent={accent} />

      {/* left accent bar */}
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: accent }} />

      {/* label */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 px-2 py-1"
        style={{
          background: "linear-gradient(to top, rgba(0,0,0,0.82), rgba(0,0,0,0))",
        }}
      >
        <div className="truncate text-[11px] font-medium" style={{ color: C.text }}>
          {clip.name}
        </div>
        <div className="truncate text-[10px] tabular-nums" style={{ color: C.muted }}>
          {meta}
        </div>
      </div>

      {/* trim handles */}
      {showHandles &&
        (["trim-l", "trim-r"] as const).map((mode) => (
          <div
            key={mode}
            onPointerDown={(e) => onPointerDown(e, clip, mode)}
            className="absolute top-0 bottom-0 z-10 flex items-center justify-center"
            style={{
              [mode === "trim-l" ? "left" : "right"]: 0,
              width: 12,
              cursor: "ew-resize",
              background: "rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ width: 3, height: 22, borderRadius: 2, background: accent }} />
          </div>
        ))}

      {/* live tooltip while dragging / hovering a selected clip */}
      {(drag || (hover && selected)) && (
        <div
          className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] tabular-nums"
          style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
        >
          {fmt(clip.start, true)} → {fmt(clip.start + clip.duration, true)}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- Filmstrip */

function Filmstrip({ thumbnails, accent }: { thumbnails?: string[]; accent: string }) {
  if (!thumbnails || thumbnails.length === 0) {
    return (
      <div
        className="absolute inset-0"
        style={{
          background: `repeating-linear-gradient(90deg, ${C.surfaceRaised} 0 22px, #232323 22px 24px)`,
          opacity: 0.9,
        }}
      >
        <div
          className="absolute inset-x-0 top-0"
          style={{ height: 2, background: accent, opacity: 0.5 }}
        />
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex">
      {thumbnails.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element -- caller-supplied frame URLs
        <img
          key={i}
          src={src}
          alt=""
          draggable={false}
          className="h-full flex-1 object-cover"
          style={{ minWidth: 0, borderRight: i < thumbnails.length - 1 ? "1px solid rgba(0,0,0,0.3)" : "none" }}
        />
      ))}
    </div>
  );
}
