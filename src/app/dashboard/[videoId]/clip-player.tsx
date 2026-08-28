"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { buildCues, toVtt } from "@/lib/captions/layout.ts";
import type { CaptionConfig } from "./caption-controls";

export interface PreviewWord {
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
  renderUrl: string | null;
  onPlayhead: (ms: number) => void;
  onCaptionLayout: (layout: { positionY: number; alignment: "left" | "center" | "right" }) => void;
}

type Mode = "source" | "rendered";

function fmt(ms: number): string {
  const clamped = Math.max(0, ms);
  const s = Math.floor(clamped / 1000);
  const tenths = Math.floor((clamped % 1000) / 100);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${tenths}`;
}

export function ClipPlayer({
  sourceUrl,
  startMs,
  endMs,
  words,
  captionsOn,
  caption,
  renderUrl,
  onPlayhead,
  onCaptionLayout,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("source");
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [renderedDurMs, setRenderedDurMs] = useState(0);
  const [dragging, setDragging] = useState(false);

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
    const bounded = Math.min(Math.max(0, v.currentTime * 1000 - baseMs), spanMs);
    setPosMs(bounded);
    onPlayhead(bounded);
  }

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

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={boxRef}
        className="relative flex items-center justify-center overflow-hidden rounded-lg bg-black"
      >
        <video
          key={src}
          ref={videoRef}
          src={src}
          playsInline
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={(e) => {
            if (mode === "rendered") setRenderedDurMs(e.currentTarget.duration * 1000);
          }}
          onEnded={() => setPlaying(false)}
          onClick={togglePlay}
          className="max-h-[58vh] w-auto max-w-full cursor-pointer"
        >
          {vttUrl && <track kind="subtitles" src={vttUrl} label="Captions" />}
        </video>

        {dragging && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-white/70" />
        )}

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
            {(caption.uppercase ? activeCue!.lines.join(" ").toUpperCase() : activeCue!.lines.join(" "))}
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
}
