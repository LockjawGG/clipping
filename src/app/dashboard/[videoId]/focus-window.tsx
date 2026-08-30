"use client";

import { memo, useRef } from "react";

import type { FocusKeyframe } from "@/lib/focus/keyframes.ts";
import { FOCUS_LIMITS, sampleFocusAt } from "@/lib/focus/keyframes.ts";

/**
 * The capture-window editor drawn over the player.
 *
 * The window's coordinates live in the *cover-scaled* frame — the render does
 * `scale=…:force_original_aspect_ratio=increase` and then crops — while the
 * player letterboxes the whole source. This component maps between the two so
 * the rectangle you drag is genuinely the region that ends up in the output:
 * the faint outline is what the aspect change alone would keep, and the solid
 * rectangle is the window inside it.
 *
 * Editing is auto-key: dragging writes a keyframe at the playhead, creating one
 * if there isn't already a keyframe there. That keeps "move it, then move it
 * again later" working without a separate record-arm step.
 */

/** A keyframe within this many ms of the playhead is edited rather than added. */
export const KEYFRAME_SNAP_MS = 120;

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

interface CoverBox {
  /** Origin + size of the cover region, as a fraction of the source frame. */
  ox: number;
  oy: number;
  w: number;
  h: number;
}

/** Which part of the source survives the aspect change, before any zoom. */
export function coverRegion(sourceAspect: number, targetAspect: number): CoverBox {
  if (!Number.isFinite(sourceAspect) || sourceAspect <= 0) return { ox: 0, oy: 0, w: 1, h: 1 };
  if (sourceAspect >= targetAspect) {
    // Source is wider: the sides are cropped.
    const w = targetAspect / sourceAspect;
    return { ox: (1 - w) / 2, oy: 0, w, h: 1 };
  }
  const h = sourceAspect / targetAspect;
  return { ox: 0, oy: (1 - h) / 2, w: 1, h };
}

/** The window in cover-space: top-left and size, clamped inside the frame. */
export function windowRect(x: number, y: number, scale: number) {
  const size = 1 / Math.max(1, scale);
  return {
    left: clamp(x - size / 2, 0, 1 - size),
    top: clamp(y - size / 2, 0, 1 - size),
    size,
  };
}

interface Props {
  track: FocusKeyframe[];
  /** Clip-relative playhead. */
  posMs: number;
  /** The letterboxed video's rect inside the player box, in px. */
  rect: { left: number; top: number; width: number; height: number };
  sourceAspect: number;
  targetAspect: number;
  /** Auto-key: write this window at the playhead. */
  onCommit: (kf: FocusKeyframe) => void;
}

export const FocusWindowOverlay = memo(function FocusWindowOverlay({
  track,
  posMs,
  rect,
  sourceAspect,
  targetAspect,
  onCommit,
}: Props) {
  const drag = useRef<{
    mode: "move" | "resize";
    startX: number;
    startY: number;
    from: { x: number; y: number; scale: number };
  } | null>(null);
  const live = useRef<{ x: number; y: number; scale: number } | null>(null);
  const nodeRef = useRef<HTMLDivElement>(null);

  const cover = coverRegion(sourceAspect, targetAspect);
  const at = sampleFocusAt(track, posMs);
  const current = live.current ?? at;

  if (rect.width === 0 || rect.height === 0) return null;

  // cover-space -> px within the player box
  const toPx = (w: { left: number; top: number; size: number }) => ({
    left: rect.left + (cover.ox + w.left * cover.w) * rect.width,
    top: rect.top + (cover.oy + w.top * cover.h) * rect.height,
    width: w.size * cover.w * rect.width,
    height: w.size * cover.h * rect.height,
  });

  const win = windowRect(current.x, current.y, current.scale);
  const px = toPx(win);

  const coverPx = {
    left: rect.left + cover.ox * rect.width,
    top: rect.top + cover.oy * rect.height,
    width: cover.w * rect.width,
    height: cover.h * rect.height,
  };

  /** Repaint without a React round-trip while the pointer is down. */
  const paint = () => {
    const el = nodeRef.current;
    if (!el || !live.current) return;
    const p = toPx(windowRect(live.current.x, live.current.y, live.current.scale));
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    el.style.width = `${p.width}px`;
    el.style.height = `${p.height}px`;
  };

  function onPointerDown(e: React.PointerEvent, mode: "move" | "resize") {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, from: { ...current } };
    live.current = { ...current };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;

    if (d.mode === "move") {
      // px -> cover-space, so a drag tracks the pointer 1:1 on screen.
      const nx = d.from.x + dx / (cover.w * rect.width || 1);
      const ny = d.from.y + dy / (cover.h * rect.height || 1);
      live.current = { ...d.from, x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) };
    } else {
      // Dragging the corner out makes the window bigger, which is *less* zoom.
      const grow = (dx + dy) / 2 / (cover.w * rect.width || 1);
      const size = clamp(1 / d.from.scale + grow * 2, 1 / FOCUS_LIMITS.scale.max, 1);
      live.current = { ...d.from, scale: clamp(1 / size, FOCUS_LIMITS.scale.min, FOCUS_LIMITS.scale.max) };
    }
    paint();
  }

  function onPointerUp(e: React.PointerEvent) {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    const d = drag.current;
    const v = live.current;
    drag.current = null;
    live.current = null;
    if (!d || !v) return;
    if (v.x === d.from.x && v.y === d.from.y && v.scale === d.from.scale) return;
    onCommit({ atMs: Math.max(0, Math.round(posMs)), x: v.x, y: v.y, scale: v.scale });
  }

  const handle = (pos: string, cursor: string) => (
    <span
      key={pos}
      onPointerDown={(e) => onPointerDown(e, "resize")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "absolute",
        width: 12,
        height: 12,
        borderRadius: 3,
        background: "rgb(var(--c-surface))",
        border: "2px solid rgb(var(--c-accent))",
        cursor,
        touchAction: "none",
        ...(pos.includes("t") ? { top: -6 } : { bottom: -6 }),
        ...(pos.includes("l") ? { left: -6 } : { right: -6 }),
      }}
    />
  );

  return (
    <>
      {/* what the aspect change alone keeps */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: coverPx.left,
          top: coverPx.top,
          width: coverPx.width,
          height: coverPx.height,
          border: "1px dashed rgba(255,255,255,0.35)",
          pointerEvents: "none",
        }}
      />
      <div
        ref={nodeRef}
        onPointerDown={(e) => onPointerDown(e, "move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="application"
        aria-label={`Capture window at ${(current.scale).toFixed(2)}x zoom — drag to move, corners to zoom`}
        style={{
          position: "absolute",
          left: px.left,
          top: px.top,
          width: px.width,
          height: px.height,
          border: "2px solid rgb(var(--c-accent))",
          background: "rgb(var(--c-accent) / 0.08)",
          cursor: "move",
          touchAction: "none",
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.28)",
        }}
      >
        {handle("tl", "nwse-resize")}
        {handle("tr", "nesw-resize")}
        {handle("bl", "nesw-resize")}
        {handle("br", "nwse-resize")}
        <span
          style={{
            position: "absolute",
            left: 0,
            top: -20,
            fontSize: 11,
            lineHeight: "16px",
            padding: "0 6px",
            borderRadius: 4,
            background: "rgb(var(--c-accent))",
            color: "rgb(var(--c-accent-fg))",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {current.scale.toFixed(2)}× · {track.length} keyframe{track.length === 1 ? "" : "s"}
        </span>
      </div>
    </>
  );
});
