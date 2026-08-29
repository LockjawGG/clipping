"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";

import { buildCues, toVtt } from "@/lib/captions/layout.ts";
import type { CaptionConfig } from "./caption-controls";
import type { OverlayView } from "./overlay-panel";
import { wordSpanCss, type WordStyle } from "./editable-transcript";

export interface PreviewWord {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

interface Props {
  sourceUrl: string;
  startMs: number;
  endMs: number;
  words: PreviewWord[];
  captionsOn: boolean;
  caption: CaptionConfig;
  wordStyles: Record<string, WordStyle>;
  renderUrl: string | null;
  overlays: OverlayView[];
  selectedOverlayId: string | null;
  onSelectOverlay: (id: string | null) => void;
  /** Commit a moved / resized overlay (fires on pointer-up, not during drag). */
  onOverlayChange: (id: string, patch: { x?: number; y?: number; scale?: number }) => void;
  onPlayhead: (ms: number) => void;
  /** Fires when playback starts / stops, so a linked timeline can follow along. */
  onPlayingChange?: (playing: boolean) => void;
  onCaptionLayout: (layout: { positionY: number; alignment: "left" | "center" | "right" }) => void;
}

type Mode = "source" | "rendered";

function fmt(ms: number): string {
  const clamped = Math.max(0, ms);
  const s = Math.floor(clamped / 1000);
  const tenths = Math.floor((clamped % 1000) / 100);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${tenths}`;
}

export const ClipPlayer = memo(function ClipPlayer({
  sourceUrl,
  startMs,
  endMs,
  words,
  captionsOn,
  caption,
  wordStyles,
  renderUrl,
  overlays,
  selectedOverlayId,
  onSelectOverlay,
  onOverlayChange,
  onPlayhead,
  onPlayingChange,
  onCaptionLayout,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("source");
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [renderedDurMs, setRenderedDurMs] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Track the player box size so DOM overlays can be placed with the same
  // maths the ffmpeg compositor uses (fraction of frame width / free space).
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const spanMs = mode === "source" ? Math.max(1, endMs - startMs) : Math.max(1, renderedDurMs);
  const baseMs = mode === "source" ? startMs : 0;

  const cues = useMemo(
    () => buildCues(words as Parameters<typeof buildCues>[0]),
    [words],
  );
  const activeCue = cues.find((c) => posMs >= c.startMs && posMs < c.endMs) ?? null;

  const vttUrl = useMemo(() => {
    if (mode !== "source" || cues.length === 0) return null;
    return URL.createObjectURL(new Blob([toVtt(cues, 0)], { type: "text/vtt" }));
  }, [cues, mode]);

  useEffect(() => {
    return () => {
      if (vttUrl) URL.revokeObjectURL(vttUrl);
    };
  }, [vttUrl]);

  // The browser <track> is a plain-text fallback; the styled DOM overlay is the
  // real WYSIWYG, so keep the native cues hidden.
  useEffect(() => {
    const v = videoRef.current;
    const t = v?.textTracks[0];
    if (t) t.mode = "hidden";
  }, [vttUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setPlaying(false);
    setPosMs(0);
    v.pause();
    const seek = () => {
      v.currentTime = baseMs / 1000;
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, renderUrl, mode, startMs, endMs]);

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    if (mode === "source" && v.currentTime >= endMs / 1000) {
      v.pause();
      v.currentTime = startMs / 1000;
      setPlaying(false);
      setPosMs(0);
      onPlayhead(0);
      return;
    }
    // While playing, the rAF loop below owns the position (smoother, ~30fps).
    // `timeupdate` still covers paused seeks and the end-of-clip stop.
    if (playing) return;
    const bounded = Math.min(Math.max(0, v.currentTime * 1000 - baseMs), spanMs);
    setPosMs(bounded);
    onPlayhead(bounded);
  }

  // Smooth playhead: sample currentTime on animation frames (throttled to ~30fps)
  // while playing, instead of the browser's coarse ~4Hz `timeupdate`.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 33) return;
      last = t;
      const v = videoRef.current;
      if (!v) return;
      const bounded = Math.min(Math.max(0, v.currentTime * 1000 - baseMs), spanMs);
      setPosMs(bounded);
      onPlayhead(bounded);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, baseMs, spanMs, onPlayhead]);

  useEffect(() => {
    onPlayingChange?.(playing);
  }, [playing, onPlayingChange]);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < baseMs / 1000 || v.currentTime >= (baseMs + spanMs) / 1000) {
        v.currentTime = baseMs / 1000;
      }
      void v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  function scrub(relMs: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = (baseMs + relMs) / 1000;
    setPosMs(relMs);
    onPlayhead(relMs);
  }

  // --- caption drag ---
  function onOverlayPointerDown(e: React.PointerEvent) {
    if (mode !== "source") return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }
  function onOverlayPointerMove(e: React.PointerEvent) {
    if (!dragging || !boxRef.current) return;
    const rect = boxRef.current.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const x = (e.clientX - rect.left) / rect.width;
    const positionY = Math.min(0.97, Math.max(0.03, y));
    const alignment = x < 0.34 ? "left" : x > 0.66 ? "right" : "center";
    onCaptionLayout({ positionY, alignment });
  }
  function onOverlayPointerUp(e: React.PointerEvent) {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
  }

  const src = mode === "rendered" && renderUrl ? renderUrl : sourceUrl;
  const scale = (boxRef.current?.clientHeight ?? 480) / 1920;
  const showOverlay = mode === "source" && captionsOn && activeCue;

  // Overlays are burned into the rendered file; in source mode preview them as
  // positioned <img>s that appear only within their clip-relative time window.
  const activeOverlays =
    mode === "source"
      ? overlays.filter((o) => {
          if (!o.url || o.hidden) return false;
          const s = o.startMs ?? 0;
          const e = o.endMs ?? spanMs;
          return posMs >= s && posMs <= e;
        })
      : [];

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={boxRef}
        onPointerDown={(e) => {
          // A press that lands on the letterbox (not the video, not an overlay)
          // clears the overlay selection.
          if (e.target === e.currentTarget) onSelectOverlay(null);
        }}
        className="relative flex items-center justify-center overflow-hidden rounded-lg bg-black"
      >
        <video
          // Remount only when switching between the source and the rendered
          // file — never on a signed-URL token refresh, which would reload the
          // element and jump the page layout.
          key={mode}
          ref={videoRef}
          src={src}
          playsInline
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={(e) => {
            if (mode === "rendered") setRenderedDurMs(e.currentTarget.duration * 1000);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onClick={togglePlay}
          className="max-h-[58vh] w-auto max-w-full cursor-pointer"
        >
          {vttUrl && <track kind="subtitles" src={vttUrl} label="Captions" />}
        </video>

        {dragging && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-white/70" />
        )}

        {activeOverlays.map((o) => (
          <OverlayImg
            key={o.id}
            overlay={o}
            boxW={box.w}
            boxH={box.h}
            selected={selectedOverlayId === o.id}
            onSelect={() => onSelectOverlay(o.id)}
            onChange={(patch) => onOverlayChange(o.id, patch)}
          />
        ))}

        {showOverlay && (
          <div
            onPointerDown={onOverlayPointerDown}
            onPointerMove={onOverlayPointerMove}
            onPointerUp={onOverlayPointerUp}
            style={{
              position: "absolute",
              top: `${caption.positionY * 100}%`,
              left: caption.alignment === "left" ? "6%" : caption.alignment === "right" ? "auto" : "50%",
              right: caption.alignment === "right" ? "6%" : "auto",
              transform: caption.alignment === "center" ? "translate(-50%, -50%)" : "translateY(-50%)",
              maxWidth: "88%",
              textAlign: caption.alignment,
              fontFamily: `"${caption.fontFamily}", Inter, sans-serif`,
              fontWeight: caption.fontWeight,
              fontSize: Math.max(11, caption.fontSizePx * scale),
              lineHeight: 1.15,
              color: caption.textColor,
              WebkitTextStroke: `${Math.max(0, caption.outlineWidthPx * scale)}px ${caption.outlineColor}`,
              paintOrder: "stroke fill",
              background: caption.backgroundColor ?? "transparent",
              padding: caption.backgroundColor ? "0.15em 0.4em" : 0,
              borderRadius: caption.backgroundColor ? "0.15em" : 0,
              textShadow: caption.backgroundColor ? "none" : "0 3px 12px rgba(0,0,0,0.6)",
              cursor: "grab",
              touchAction: "none",
              userSelect: "none",
            }}
          >
            {(activeCue!.words as PreviewWord[]).map((w, i) => {
              const text = caption.uppercase ? w.text.toUpperCase() : w.text;
              return (
                <span key={w.id ?? i} style={wordSpanCss(wordStyles[w.id])}>
                  {i > 0 ? " " : ""}
                  {text}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "Pause" : "Play"}
          className="btn btn-ghost btn-sm w-9"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          min={0}
          max={spanMs}
          step={10}
          value={Math.min(posMs, spanMs)}
          onChange={(e) => scrub(Number(e.target.value))}
          className="min-w-0 flex-1"
          aria-label="Scrub clip"
        />
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
          {fmt(posMs)} / {fmt(spanMs)}
        </span>
      </div>

      {renderUrl && (
        <div className="seg self-start">
          {(["source", "rendered"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const clampScale = (n: number) => Math.min(4, Math.max(0.05, n));

/**
 * One overlay image previewed over the video, directly manipulable: click to
 * select, drag to move, drag the corner handle to resize. Mirrors the ffmpeg
 * compositor — width is 30%·scale of the frame width; x / y move the image
 * across the free space (0 = flush left/top, 1 = flush right/bottom, 0.5 =
 * centred).
 *
 * Smoothness: the committed geometry (`left`/`top`/`width`) is set once from
 * props; during a gesture we only mutate a CSS `transform` on the DOM node
 * imperatively (translate for move, scale for resize). Transforms are
 * GPU-composited, so no layout / paint / image re-sample happens per frame.
 * The real x / y / scale is computed and committed once, on pointer-up.
 */
function OverlayImg({
  overlay,
  boxW,
  boxH,
  selected,
  onSelect,
  onChange,
}: {
  overlay: OverlayView;
  boxW: number;
  boxH: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: { x?: number; y?: number; scale?: number }) => void;
}) {
  const [ratio, setRatio] = useState(1); // natural height / width
  const nodeRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    mode: "move" | "resize";
    startX: number;
    startY: number;
    raf: number;
    dx: number;
    dy: number;
    k: number;
  } | null>(null);

  if (!overlay.url || boxW === 0) return null;

  const w = boxW * 0.3 * clampScale(overlay.scale);
  const h = w * ratio;
  const left = (boxW - w) * clamp01(overlay.x);
  const top = (boxH - h) * clamp01(overlay.y);

  const paint = () => {
    const d = drag.current;
    const el = nodeRef.current;
    if (!d || !el) return;
    el.style.transform =
      d.mode === "move"
        ? `translate(${d.dx}px, ${d.dy}px)`
        : `scale(${d.k})`;
    d.raf = 0;
  };

  function onPointerDown(e: React.PointerEvent, mode: "move" | "resize") {
    e.stopPropagation();
    e.preventDefault();
    if (!selected) onSelect();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, raf: 0, dx: 0, dy: 0, k: 1 };
    if (nodeRef.current) {
      nodeRef.current.style.willChange = "transform";
      nodeRef.current.style.transformOrigin = mode === "resize" ? "top left" : "center";
    }
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === "move") {
      d.dx = dx;
      d.dy = dy;
    } else {
      // grow/shrink from the current width by the horizontal drag
      d.k = Math.max(0.1, (w + dx) / w);
    }
    if (!d.raf) d.raf = requestAnimationFrame(paint);
  }
  function onPointerUp(e: React.PointerEvent) {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    const d = drag.current;
    drag.current = null;
    const el = nodeRef.current;
    if (d?.raf) cancelAnimationFrame(d.raf);
    if (el) {
      el.style.transform = "";
      el.style.willChange = "";
    }
    if (!d) return;

    const patch: { x?: number; y?: number; scale?: number } = {};
    if (d.mode === "move" && (Math.abs(d.dx) > 1 || Math.abs(d.dy) > 1)) {
      const freeX = Math.max(1, boxW - w);
      const freeY = Math.max(1, boxH - h);
      patch.x = clamp01(overlay.x + d.dx / freeX);
      patch.y = clamp01(overlay.y + d.dy / freeY);
    } else if (d.mode === "resize" && Math.abs(d.k - 1) > 0.01) {
      patch.scale = clampScale(overlay.scale * d.k);
    }
    if (Object.keys(patch).length) onChange(patch);
  }

  return (
    <div
      ref={nodeRef}
      onPointerDown={(e) => onPointerDown(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "absolute",
        left,
        top,
        width: w,
        height: h || "auto",
        opacity: overlay.opacity,
        cursor: selected ? "move" : "pointer",
        touchAction: "none",
        outline: selected ? "2px solid rgb(var(--c-accent))" : "1px dashed rgba(255,255,255,0.35)",
        outlineOffset: 2,
      }}
      title={selected ? `${overlay.name} — drag to move` : `${overlay.name} — click to select`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL */}
      <img
        src={overlay.url}
        alt=""
        draggable={false}
        onLoad={(e) => {
          const el = e.currentTarget;
          if (el.naturalWidth > 0) setRatio(el.naturalHeight / el.naturalWidth);
        }}
        style={{ width: "100%", height: "auto", display: "block", pointerEvents: "none", userSelect: "none" }}
      />
      {selected && (
        <>
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
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {overlay.name}
          </span>
          <div
            onPointerDown={(e) => onPointerDown(e, "resize")}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              position: "absolute",
              right: -7,
              bottom: -7,
              width: 14,
              height: 14,
              borderRadius: 3,
              background: "rgb(var(--c-accent))",
              border: "2px solid #fff",
              cursor: "nwse-resize",
            }}
          />
        </>
      )}
    </div>
  );
}
