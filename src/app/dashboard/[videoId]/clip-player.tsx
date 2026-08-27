"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { buildCues, toVtt } from "@/lib/captions/layout.ts";

export interface PreviewWord {
  text: string;
  startMs: number;
  endMs: number;
}

interface Props {
  sourceUrl: string;
  /** Saved clip window, in source-timeline ms. */
  startMs: number;
  endMs: number;
  /** Clip-relative words (already rebased to 0 = clip start). */
  words: PreviewWord[];
  captionsOn: boolean;
  renderUrl: string | null;
  /** Fires with the clip-relative playhead position, in ms. */
  onPlayhead: (ms: number) => void;
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
  renderUrl,
  onPlayhead,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<Mode>("source");
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [renderedDurMs, setRenderedDurMs] = useState(0);

  const spanMs = mode === "source" ? Math.max(1, endMs - startMs) : Math.max(1, renderedDurMs);
  const baseMs = mode === "source" ? startMs : 0;

  // Live caption track — built client-side, no render round-trip.
  const vttUrl = useMemo(() => {
    if (mode !== "source" || words.length === 0) return null;
    const cues = buildCues(words as Parameters<typeof buildCues>[0]);
    if (cues.length === 0) return null;
    return URL.createObjectURL(new Blob([toVtt(cues, 0)], { type: "text/vtt" }));
  }, [words, mode]);

  useEffect(() => {
    return () => {
      if (vttUrl) URL.revokeObjectURL(vttUrl);
    };
  }, [vttUrl]);

  // Toggle the rendered cue track without reloading the video.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const track = v.textTracks[0];
    if (track) track.mode = captionsOn && mode === "source" ? "showing" : "hidden";
  }, [captionsOn, mode, vttUrl]);

  // Re-seek to the window start whenever the source/window/mode changes.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- baseMs derives from these
  }, [sourceUrl, renderUrl, mode, startMs, endMs]);

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    const rel = v.currentTime * 1000 - baseMs;
    if (mode === "source" && v.currentTime >= endMs / 1000) {
      v.pause();
      v.currentTime = startMs / 1000;
      setPlaying(false);
      setPosMs(0);
      onPlayhead(0);
      return;
    }
    const bounded = Math.min(Math.max(0, rel), spanMs);
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

  const src = mode === "rendered" && renderUrl ? renderUrl : sourceUrl;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-center overflow-hidden rounded-lg bg-black">
        <video
          // key forces a fresh element (and track) when the src changes
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
          className="max-h-[60vh] w-auto max-w-full cursor-pointer"
        >
          {vttUrl && <track kind="subtitles" src={vttUrl} default label="Captions" />}
        </video>
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
        <div className="flex items-center gap-1 self-start rounded-lg border border-border bg-surface p-0.5 text-xs">
          {(["source", "rendered"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-2.5 py-1 font-medium capitalize transition-colors ${
                mode === m ? "bg-accent text-accent-fg" : "text-muted hover:text-text"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
