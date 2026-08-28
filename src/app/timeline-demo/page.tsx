"use client";

/**
 * Usage example for <Timeline />.
 *
 * Visit /timeline-demo. Everything here is mock data — the component itself has
 * no app dependencies. Wire `onClipsChange` / `onSeek` to your real store to
 * make it authoritative.
 */

import { useMemo, useState } from "react";

import { Timeline } from "@/components/timeline/Timeline";
import type { TimelineClip, TimelineTrack } from "@/components/timeline/timeline-types";

/** A fake filmstrip frame as an inline SVG data URI. */
function frame(hue: number, n: number) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='72'>
    <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0' stop-color='hsl(${hue} 55% 34%)'/>
      <stop offset='1' stop-color='hsl(${(hue + 40) % 360} 55% 22%)'/>
    </linearGradient></defs>
    <rect width='120' height='72' fill='url(#g)'/>
    <circle cx='${20 + ((n * 17) % 80)}' cy='${18 + ((n * 11) % 36)}' r='9' fill='hsl(${hue} 70% 60% / .5)'/>
    <text x='6' y='66' font-family='monospace' font-size='10' fill='rgba(255,255,255,.5)'>${String(n).padStart(2, "0")}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
const strip = (hue: number, count: number) =>
  Array.from({ length: count }, (_, i) => frame(hue, i + 1));

const TRACKS: TimelineTrack[] = [
  { id: "v1", label: "V1", kind: "video" },
  { id: "v2", label: "V2", kind: "overlay" },
  { id: "a1", label: "A1", kind: "audio" },
];

const INITIAL_CLIPS: TimelineClip[] = [
  {
    id: "c1",
    trackId: "v1",
    name: "A064716.hd.1920.1080.23fps.mp4",
    start: 0,
    duration: 17_210,
    sourceIn: 0,
    sourceOut: 17_210,
    sourceDuration: 42_000,
    width: 1920,
    height: 1080,
    fps: 23,
    thumbnails: strip(190, 8),
  },
  {
    id: "c2",
    trackId: "v1",
    name: "B-roll_skyline.mp4",
    start: 19_000,
    duration: 9_500,
    sourceIn: 3_000,
    sourceOut: 12_500,
    sourceDuration: 30_000,
    width: 3840,
    height: 2160,
    fps: 30,
    thumbnails: strip(25, 5),
  },
  {
    id: "c3",
    trackId: "v2",
    name: "logo_lower_third.png",
    start: 4_000,
    duration: 6_000,
    sourceIn: 0,
    sourceOut: 6_000,
    sourceDuration: 6_000,
    width: 900,
    height: 300,
    accent: "#B085F5",
  },
  {
    id: "c4",
    trackId: "a1",
    name: "music_bed_loop.wav",
    start: 0,
    duration: 28_500,
    sourceIn: 0,
    sourceOut: 28_500,
    sourceDuration: 60_000,
  },
];

export default function TimelineDemoPage() {
  const [clips, setClips] = useState(INITIAL_CLIPS);
  const [tracks, setTracks] = useState(TRACKS);
  const [playhead, setPlayhead] = useState(2_400);
  const [selected, setSelected] = useState<string | null>("c1");
  const [playing, setPlaying] = useState(false);

  const summary = useMemo(
    () => clips.map((c) => `${c.name} @ ${(c.start / 1000).toFixed(1)}s ×${(c.duration / 1000).toFixed(1)}s`),
    [clips],
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold">Timeline component</h1>

      <Timeline
        className="h-[360px]"
        tracks={tracks}
        onTracksChange={setTracks}
        clips={clips}
        onClipsChange={setClips}
        playheadMs={playhead}
        onSeek={setPlayhead}
        selectedClipId={selected}
        onSelectClip={setSelected}
        playing={playing}
        onTogglePlay={() => setPlaying((p) => !p)}
        onImport={(files) => alert(`import ${files.length} file(s)`)}
      />

      <div className="rounded-lg border border-border bg-surface p-3 text-xs text-muted">
        <p className="mb-1 font-medium text-text">Live state</p>
        <p>playhead {(playhead / 1000).toFixed(2)}s · selected {selected ?? "—"}</p>
        <ul className="mt-1 list-disc pl-4">
          {summary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
        <p className="mt-2">
          Space play/pause · ←/→ nudge (⇧ = 1s) · Delete removes selection · ⌘/Ctrl+wheel zooms.
        </p>
      </div>
    </div>
  );
}
