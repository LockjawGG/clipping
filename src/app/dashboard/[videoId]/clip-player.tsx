"use client";

import { useCallback, Fragment, memo, useEffect, useMemo, useRef, useState } from "react";

import { buildCues, toVtt } from "@/lib/captions/layout.ts";
import {
  textStyleFromParts,
  textStyleToCss,
  parseStylePartial,
  resolveTextStyle,
} from "@/lib/captions/text-style.ts";
import { parseWordRules, applyWordRules, wordEffectCss } from "@/lib/captions/word-rules.ts";
import { captionWordAnim, captionCueAnim, NEUTRAL_CAPTION_CSS } from "@/lib/captions/anim-dom.ts";
import { sampleElementAnim, parseElementAnim } from "@/lib/captions/element-anim.ts";
import type { FocusKeyframe } from "@/lib/focus/keyframes.ts";
import { FocusWindowOverlay } from "./focus-window";
import { remotionPreset } from "@/lib/captions/presets.ts";
import type { CaptionConfig } from "./caption-controls";
import type { OverlayView } from "./overlay-panel";
import { wordSpanCss, type WordStyle } from "./editable-transcript";
import { TONES } from "@/lib/ffmpeg/args.ts";
import { previewMs, type PreviewMs } from "@/lib/sequence/clock.ts";

/**
 * How far ahead of a bleep the clip's audio is cut.
 *
 * The render silences the span to the sample. The preview can only act on a
 * position it read on the last frame callback, so acting exactly on the
 * boundary is always a little late — measured at 44-56ms, which is the whole of
 * the lead `audioSpans` puts in front of the word. Being early is inaudible
 * (the span already opens in the gap before the word); being late is the word.
 */
const BLEEP_LEAD_MS = 90;

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
  /**
   * The pieces the render will cut and join, in timeline order.
   *
   * This is the clip as the export will be: the timeline's edits and any words
   * struck out of the middle, already applied. The preview walks it rather than
   * playing the untouched source window, so a split, a reorder and a cut are
   * all visible before rendering. Empty falls back to the clip's own window.
   */
  plan?: ReadonlyArray<{
    sourceVideoId: string;
    sourceIn: number;
    sourceOut: number;
    timelineStart: number;
    durationMs: number;
  }>;
  /**
   * Pieces on the lanes above the base. Each covers the base for as long as it
   * lasts, letterboxed into the frame — the render's `overlay` chain, which
   * takes only the base's audio, so these play silent.
   */
  planLayers?: ReadonlyArray<{
    sourceVideoId: string;
    sourceIn: number;
    sourceOut: number;
    timelineStart: number;
    durationMs: number;
  }>;
  /** A playable URL per source video id the plan references. */
  planSourceUrls?: Record<string, string>;
  /**
   * Narration to play over the clip, placed exactly where the render will put
   * it. Times are clip-relative. Without this the preview is silent about a
   * voiceover that the export would contain.
   */
  voiceover?: {
    duckDb: number;
    lines: ReadonlyArray<{ ref: string; startMs: number; playedMs: number; tempo: number; url: string }>;
  } | null;
  /**
   * Stretches the render replaces with a bleep, clip-relative. The preview
   * silences the clip across them and makes the same sound, so a censor pass
   * can be checked by ear before committing to a render — the captions were
   * always masked here, but the speech underneath used to play in the clear.
   */
  bleeps?: ReadonlyArray<{ startMs: number; endMs: number; mode: "MUTE" | "BEEP" | "TONE" }>;
  words: PreviewWord[];
  captionsOn: boolean;
  caption: CaptionConfig;
  wordStyles: Record<string, WordStyle>;
  renderUrl: string | null;
  /** Seek the preview to `ms` (clip-relative). `n` changes even on a repeat
   *  request for the same position so the effect re-fires. */
  seekToMs?: { ms: PreviewMs; n: number } | null;
  /** Bump `n` to toggle play/pause from outside (a keyboard shortcut). */
  togglePlayReq?: { n: number } | null;
  overlays: OverlayView[];
  selectedOverlayId: string | null;
  onSelectOverlay: (id: string | null) => void;
  /** Commit a moved / resized overlay (fires on pointer-up, not during drag). */
  onOverlayChange: (id: string, patch: { x?: number; y?: number; scale?: number }) => void;
  onPlayhead: (ms: PreviewMs) => void;
  /** Fires when playback starts / stops, so a linked timeline can follow along. */
  onPlayingChange?: (playing: boolean) => void;
  /** The <video> failed to load its source (e.g. an expired signed URL) — the
   *  parent can refresh to mint a fresh one. Fires at most once per source. */
  onSourceError?: () => void;
  onCaptionLayout: (layout: { positionY: number; alignment: "left" | "center" | "right" }) => void;
  /** The authored capture window; an empty array hides the editor. */
  focusTrack?: FocusKeyframe[];
  /** Target frame aspect as width/height, e.g. 1080/1920. */
  targetAspect?: number;
  /** Auto-key a window at the playhead. Absent = the editor is read-only. */
  onFocusCommit?: (kf: FocusKeyframe) => void;
  /** Show the capture-window editor. */
  focusEditing?: boolean;
}

type Mode = "source" | "rendered";

/** Where a letterboxed (object-fit: contain) video is actually drawn. */
function videoRect(box: { w: number; h: number }, aspect: number) {
  if (box.w === 0 || box.h === 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { left: 0, top: 0, width: box.w, height: box.h };
  }
  const boxAspect = box.w / box.h;
  if (aspect >= boxAspect) {
    const height = box.w / aspect;
    return { left: 0, top: (box.h - height) / 2, width: box.w, height };
  }
  const width = box.h * aspect;
  return { left: (box.w - width) / 2, top: 0, width, height: box.h };
}

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
  plan,
  planLayers,
  planSourceUrls,
  voiceover,
  bleeps,
  words,
  captionsOn,
  caption,
  wordStyles,
  renderUrl,
  seekToMs,
  togglePlayReq,
  overlays,
  selectedOverlayId,
  onSelectOverlay,
  onOverlayChange,
  onPlayhead,
  onPlayingChange,
  onSourceError,
  onCaptionLayout,
  focusTrack,
  targetAspect = 1080 / 1920,
  onFocusCommit,
  focusEditing = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const erroredSrc = useRef<string | null>(null);
  const [mode, setMode] = useState<Mode>("source");
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [renderedDurMs, setRenderedDurMs] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // The source's intrinsic size, so the capture-window editor can map between
  // the letterboxed preview and the cover-scaled frame the render crops from.
  const [natural, setNatural] = useState({ w: 0, h: 0 });

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

  /**
   * The pieces to walk, in timeline order. A clip with nothing to compose still
   * gets one piece — its own window — so there is a single code path.
   */
  const pieces = useMemo(() => {
    const list = (plan ?? []).filter((p) => p.durationMs > 0);
    if (list.length === 0) {
      return [
        {
          sourceVideoId: "",
          sourceIn: startMs,
          sourceOut: endMs,
          timelineStart: 0,
          durationMs: Math.max(1, endMs - startMs),
        },
      ];
    }
    return [...list].sort((a, b) => a.timelineStart - b.timelineStart);
  }, [plan, startMs, endMs]);

  const planMs = useMemo(
    () => pieces.reduce((end, p) => Math.max(end, p.timelineStart + p.durationMs), 0),
    [pieces],
  );
  /** Which piece is on screen. An index, because pieces can repeat a source. */
  const activeIdx = useRef(0);
  if (activeIdx.current >= pieces.length) activeIdx.current = 0;

  const spanMs = mode === "source" ? Math.max(1, planMs) : Math.max(1, renderedDurMs);
  /** Where the active piece starts in its source — the render path has none. */
  const baseMs = mode === "source" ? (pieces[activeIdx.current]?.sourceIn ?? startMs) : 0;

  /** Timeline position → the piece playing there and its moment of the source. */
  const locate = useCallback(
    (posMs: number) => {
      const at = Math.min(Math.max(0, posMs), Math.max(0, planMs - 1));
      let i = pieces.findIndex((p) => at >= p.timelineStart && at < p.timelineStart + p.durationMs);
      if (i < 0) i = pieces.length - 1;
      return { index: i, piece: pieces[i], sourceMs: pieces[i].sourceIn + (at - pieces[i].timelineStart) };
    },
    [pieces, planMs],
  );

  /** The source that should be loaded for the piece on screen. */
  const activeSrc =
    planSourceUrls?.[pieces[activeIdx.current]?.sourceVideoId ?? ""] ?? sourceUrl;

  const cues = useMemo(
    () => buildCues(words as Parameters<typeof buildCues>[0]),
    [words],
  );
  const activeCue = cues.find((c) => posMs >= c.startMs && posMs < c.endMs) ?? null;

  /**
   * The `<track>` fallback, built only in the browser.
   *
   * `URL.createObjectURL` runs on the server too if this is computed during
   * render, and the `blob:nodedata:` URL that produces is both a hydration
   * mismatch and something the browser refuses to load — so the fallback never
   * arrived, and every clip logged two console errors on the way. Creating it
   * after mount means the server renders no track at all and the client adds
   * the one that works.
   */
  const [vttUrl, setVttUrl] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== "source" || cues.length === 0) {
      setVttUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([toVtt(cues, 0)], { type: "text/vtt" }));
    setVttUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [cues, mode]);

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
    activeIdx.current = 0;
    v.pause();
    const seek = () => {
      // Assigning the position the element is already at (0 -> 0) is a no-op,
      // so nothing decodes and the frame stays black. Nudge off zero to force
      // the first frame to paint.
      v.currentTime = baseMs > 0 ? baseMs / 1000 : 0.04;
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, renderUrl, mode, startMs, endMs, planMs]);

  /**
   * Show, hide and seek the lanes above the base.
   *
   * A layer is its own element stacked over the base video. It is silent
   * because the render is: the composite maps only the base's audio. And the
   * base plays on underneath — a layer covers part of the clip, not all of it.
   */
  const layerRefs = useRef(new Map<number, HTMLVideoElement>());
  const syncLayers = useCallback(
    (posMs: number, running: boolean) => {
      const list = mode === "source" ? (planLayers ?? []) : [];
      list.forEach((layer, i) => {
        const el = layerRefs.current.get(i);
        if (!el) return;
        const on = posMs >= layer.timelineStart && posMs < layer.timelineStart + layer.durationMs;
        el.style.visibility = on ? "visible" : "hidden";
        if (!on) {
          if (!el.paused) el.pause();
          return;
        }
        const want = (layer.sourceIn + (posMs - layer.timelineStart)) / 1000;
        if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
        if (running && el.paused) void el.play().catch(() => {});
        if (!running && !el.paused) el.pause();
      });
    },
    [planLayers, mode],
  );

  /**
   * Where the playhead is on the timeline, read from the element's own clock
   * through whichever piece is showing.
   */
  const timelinePos = useCallback((): PreviewMs => {
    const v = videoRef.current;
    if (!v) return previewMs(0);
    if (mode !== "source") return previewMs(Math.min(Math.max(0, v.currentTime * 1000), spanMs));
    const piece = pieces[activeIdx.current] ?? pieces[0];
    const at = piece.timelineStart + (v.currentTime * 1000 - piece.sourceIn);
    return previewMs(Math.min(Math.max(0, at), spanMs));
  }, [mode, pieces, spanMs]);

  /**
   * Move to the next piece when the current one runs out.
   *
   * The element plays one continuous source, so the joins are the player's job:
   * at the end of a piece it seeks to wherever the next one starts. Pieces that
   * happen to be contiguous in the same source need no seek at all, which is
   * why an untouched clip plays exactly as smoothly as it always did.
   *
   * Returns true when it moved, so the caller can let the next frame report the
   * position rather than reading a stale one.
   */
  const advance = useCallback(() => {
    const v = videoRef.current;
    if (!v || mode !== "source") return false;
    const piece = pieces[activeIdx.current];
    if (!piece) return false;
    const srcMs = v.currentTime * 1000;
    // A little tolerance: the element rarely lands exactly on the boundary.
    if (srcMs < piece.sourceOut - 20 && srcMs >= piece.sourceIn - 250) return false;

    const next = pieces[activeIdx.current + 1];
    if (!next) {
      // Playing off the end rewinds; parking there does not. Scrubbing to the
      // last frame used to throw the playhead back to the start, because the
      // end-of-clip stop could not tell a seek from playback running out.
      if (!playing) return false;
      v.pause();
      setPlaying(false);
      activeIdx.current = 0;
      v.currentTime = pieces[0].sourceIn / 1000;
      setPosMs(0);
      onPlayhead(previewMs(0));
      return true;
    }
    activeIdx.current += 1;
    const continuous =
      next.sourceVideoId === piece.sourceVideoId && Math.abs(next.sourceIn - piece.sourceOut) < 40;
    if (!continuous) v.currentTime = next.sourceIn / 1000;
    return !continuous;
  }, [mode, pieces, onPlayhead, playing]);

  /**
   * Keep the narration lined up with the playhead.
   *
   * One audio element per line, seeked rather than restarted, so scrubbing
   * lands mid-line the way it does in the finished video. While a line plays
   * the clip's own audio is ducked by the same dB the render will duck it by —
   * at 0 dB that is deliberately nothing, and the narration sits on top of the
   * original at full volume.
   */
  const voRefs = useRef(new Map<string, HTMLAudioElement>());
  const activeVo = useRef<string | null>(null);
  const syncVoiceover = useCallback(
    (posMs: number, running: boolean) => {
      const v = videoRef.current;
      const lines = mode === "source" ? (voiceover?.lines ?? []) : [];
      if (!v) return false;
      if (lines.length === 0) {
        activeVo.current = null;
        return false;
      }
      const active = lines.find((l) => posMs >= l.startMs && posMs < l.startMs + l.playedMs) ?? null;

      if (activeVo.current && activeVo.current !== active?.ref) {
        voRefs.current.get(activeVo.current)?.pause();
        activeVo.current = null;
      }
      if (!active) return false;
      const el = voRefs.current.get(active.ref);
      if (!el) return;
      // Tempo compresses the line, so a millisecond of the clip is `tempo`
      // milliseconds of the audio file.
      const want = ((posMs - active.startMs) * active.tempo) / 1000;
      if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
      el.playbackRate = active.tempo;
      if (running && el.paused) void el.play().catch(() => {});
      if (!running && !el.paused) el.pause();
      activeVo.current = active.ref;
      return true;
    },
    [voiceover, mode],
  );

  /**
   * The bleep, made with an oscillator rather than a file.
   *
   * The tone table is the render's own, so what you hear is the frequency and
   * level ffmpeg will mix in. The clip's audio is silenced across the span in
   * every mode — that is what censoring the audio means; the tone is only what
   * replaces it.
   */
  const toneRef = useRef<{ ctx: AudioContext; osc: OscillatorNode; gain: GainNode } | null>(null);
  const stopTone = useCallback(() => {
    const t = toneRef.current;
    if (!t) return;
    t.gain.gain.value = 0;
  }, []);
  const playTone = useCallback((mode: "BEEP" | "TONE") => {
    const spec = TONES[mode];
    let t = toneRef.current;
    if (!t) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.type = "sine";
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      t = { ctx, osc, gain };
      toneRef.current = t;
    }
    if (t.ctx.state === "suspended") void t.ctx.resume();
    t.osc.frequency.value = spec.hz;
    t.gain.gain.value = spec.gain;
  }, []);

  useEffect(
    () => () => {
      const t = toneRef.current;
      toneRef.current = null;
      if (t) {
        try {
          t.osc.stop();
          void t.ctx.close();
        } catch {
          /* already gone */
        }
      }
    },
    [],
  );

  /**
   * What the clip's own audio should be doing at this instant.
   *
   * One place, because two features both want a say: a bleep silences it
   * outright, and narration ducks it. A bleep wins — the point of censoring is
   * that the speech does not come through.
   */
  const syncAudio = useCallback(
    (posMs: number, running: boolean) => {
      const v = videoRef.current;
      if (!v) return;
      syncLayers(posMs, running);
      const narrating = syncVoiceover(posMs, running);
      // Silence starts early. This is read on a frame callback, so the position
      // it acts on is already a frame or so old; muting exactly on the boundary
      // put the change in after the word's first sample and you heard the
      // attack of it under the tone. Ending is left exact — the span's own
      // trailing pad covers it, and cutting the clip's audio back in late is
      // the one direction nobody can hear.
      const bleep =
        mode === "source"
          ? (bleeps ?? []).find((b) => posMs >= b.startMs - BLEEP_LEAD_MS && posMs < b.endMs)
          : undefined;

      if (bleep) {
        v.volume = 0;
        // The tone is the replacement, so it starts with the word, not with the
        // lead — otherwise censoring announces itself before there is anything
        // to censor.
        if (running && bleep.mode !== "MUTE" && posMs >= bleep.startMs) playTone(bleep.mode);
        else stopTone();
        return;
      }
      stopTone();
      v.volume = narrating ? Math.pow(10, (voiceover?.duckDb ?? 0) / 20) : 1;
    },
    [bleeps, mode, playTone, stopTone, syncLayers, syncVoiceover, voiceover],
  );

  /**
   * Re-apply the instant when what it should sound like changes.
   *
   * Turning the audio censor off while parked inside a bleep used to leave the
   * clip muted: nothing re-ran until the next frame or seek, and a paused
   * player has neither. The same for turning it on — the settings said bleeped
   * and the speech carried on.
   */
  useEffect(() => {
    syncAudio(posMs, playing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bleeps, voiceover, mode, syncAudio]);

  // Nothing should keep talking once the video stops.
  useEffect(() => {
    if (playing) return;
    for (const el of voRefs.current.values()) el.pause();
    for (const el of layerRefs.current.values()) el.pause();
    stopTone();
  }, [playing, stopTone]);

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    // Reaching the end of a piece is what ends the clip now — the last piece's
    // own end, not the clip window's, since the timeline decides the length.
    if (advance()) return;
    // While playing, the rAF loop below owns the position (smoother, ~30fps).
    // `timeupdate` still covers paused seeks.
    if (playing) return;
    const bounded = timelinePos();
    setPosMs(bounded);
    onPlayhead(bounded);
    syncAudio(bounded, false);
  }

  // Smooth playhead: sample currentTime on animation frames (throttled to ~30fps)
  // while playing, instead of the browser's coarse ~4Hz `timeupdate`.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const v = videoRef.current;
      if (!v) return;
      if (advance()) return;
      const bounded = timelinePos();
      // Audio every frame. The throttle below is for the playhead, which only
      // has to look smooth; censoring that arrives a frame late has already
      // let the word through, so it does not get to share that budget.
      syncAudio(bounded, true);
      if (t - last < 33) return;
      last = t;
      setPosMs(bounded);
      onPlayhead(bounded);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, onPlayhead, advance, timelinePos, syncAudio]);

  useEffect(() => {
    onPlayingChange?.(playing);
  }, [playing, onPlayingChange]);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      // Off the end, or outside the piece on screen: start again from the top
      // of the timeline rather than wherever the element happens to sit.
      const piece = pieces[activeIdx.current];
      const srcMs = v.currentTime * 1000;
      if (mode === "source" && piece && (srcMs < piece.sourceIn - 250 || srcMs >= piece.sourceOut)) {
        activeIdx.current = 0;
        v.currentTime = pieces[0].sourceIn / 1000;
      }
      void v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  function scrub(relMs: PreviewMs) {
    const v = videoRef.current;
    if (!v) return;
    if (mode === "source") {
      // A timeline position means nothing to the element; it has to be turned
      // back into a moment of whichever source plays there.
      const { index, sourceMs } = locate(relMs);
      activeIdx.current = index;
      v.currentTime = sourceMs / 1000;
    } else {
      v.currentTime = relMs / 1000;
    }
    setPosMs(relMs);
    onPlayhead(relMs);
  }

  // Seek requested from outside (a transcript word click). Only in source mode —
  // the rendered file has a different timebase.
  useEffect(() => {
    if (!seekToMs || mode !== "source") return;
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    setPlaying(false);
    scrub(previewMs(Math.min(Math.max(0, seekToMs.ms), spanMs)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToMs?.n]);

  useEffect(() => {
    if (togglePlayReq && mode === "source") togglePlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [togglePlayReq?.n]);

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

  const src = mode === "rendered" && renderUrl ? renderUrl : activeSrc;
  const scale = (boxRef.current?.clientHeight ?? 480) / 1920;
  const showOverlay = mode === "source" && captionsOn && activeCue;

  // WYSIWYG caption styling: resolve the rich TextStyle from the scalar caption
  // config + its styleJson blob, then render through the same helpers the burn
  // uses (textStyleToCss + the DOM animation interpreter).
  const richStyle = useMemo(
    () =>
      textStyleFromParts(
        {
          fontFamily: caption.fontFamily,
          fontSizePx: caption.fontSizePx,
          fontWeight: caption.fontWeight,
          textColor: caption.textColor,
          highlightColor: caption.highlightColor,
          outlineColor: caption.outlineColor,
          outlineWidthPx: caption.outlineWidthPx,
          backgroundColor: caption.backgroundColor,
          alignment: caption.alignment,
          positionY: caption.positionY,
          uppercase: caption.uppercase,
        },
        caption.styleJson,
      ),
    [caption],
  );
  const richCss = useMemo(() => textStyleToCss(richStyle, { scale }), [richStyle, scale]);
  const captionWordRules = useMemo(
    () => parseWordRules(caption.wordRulesJson),
    [caption.wordRulesJson],
  );
  const captionAnimId = caption.animation === "NONE" ? "none" : remotionPreset(caption.animation);
  const gradientFill = richStyle.fill.kind !== "solid";
  const cueCss =
    activeCue != null
      ? captionCueAnim(captionAnimId, posMs, { startMs: activeCue.startMs, endMs: activeCue.endMs })
      : NEUTRAL_CAPTION_CSS;
  const placementTransform =
    caption.alignment === "center" ? "translate(-50%, -50%)" : "translateY(-50%)";
  const overlayTransform =
    cueCss.transform && cueCss.transform !== "none"
      ? `${placementTransform} ${cueCss.transform}`
      : placementTransform;

  // Overlays are burned into the rendered file; in source mode preview them as
  // positioned elements that appear only within their clip-relative time window.
  const activeOverlays =
    mode === "source"
      ? overlays.filter((o) => {
          if (o.hidden) return false;
          if (o.kind !== "TEXT" && !o.url) return false;
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
          // "metadata" is enough for a seekable MP4, but a WebM written by
          // MediaRecorder needs actual frame data before it will paint one —
          // with metadata-only preload the element stays black until you press
          // play. "auto" makes the first frame appear immediately.
          preload="auto"
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={(e) => {
            if (mode === "rendered") setRenderedDurMs(e.currentTarget.duration * 1000);
            const v = e.currentTarget;
            if (v.videoWidth > 0) setNatural({ w: v.videoWidth, h: v.videoHeight });
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => {
            if (erroredSrc.current === src) return; // one report per source
            erroredSrc.current = src;
            onSourceError?.();
          }}
          onClick={togglePlay}
          className="max-h-[58vh] w-auto max-w-full cursor-pointer"
        >
          {vttUrl && <track kind="subtitles" src={vttUrl} label="Captions" />}
        </video>
        {/* Lanes above the base, stacked over it. `object-contain` is the
            preview's version of the render's scale-to-fit-and-pad: the layer
            keeps its shape and the base shows through the letterboxing.
            Muted, because the composite maps only the base's audio. */}
        {mode === "source" &&
          (planLayers ?? []).map((layer, i) => {
            const url = planSourceUrls?.[layer.sourceVideoId];
            if (!url) return null;
            return (
              <video
                key={`${layer.sourceVideoId}-${layer.timelineStart}-${i}`}
                ref={(el) => {
                  if (el) layerRefs.current.set(i, el);
                  else layerRefs.current.delete(i);
                }}
                src={url}
                muted
                playsInline
                preload="auto"
                style={{ visibility: "hidden" }}
                onClick={togglePlay}
                className="pointer-events-auto absolute inset-0 m-auto h-full w-full cursor-pointer object-contain"
              />
            );
          })}

        {/* Narration, one element per line. Hidden: the video element
            stays the only thing on screen, these only make sound. */}
        {mode === "source" &&
          (voiceover?.lines ?? []).map((l) => (
            <audio
              key={l.ref}
              ref={(el) => {
                if (el) voRefs.current.set(l.ref, el);
                else voRefs.current.delete(l.ref);
              }}
              src={l.url}
              preload="auto"
              hidden
            />
          ))}

        {dragging && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-white/70" />
        )}

        {focusEditing && onFocusCommit && natural.w > 0 && box.w > 0 && (
          <FocusWindowOverlay
            track={focusTrack ?? []}
            posMs={posMs}
            // The <video> is letterboxed inside the box, so derive its drawn
            // rect rather than assuming it fills the container.
            rect={videoRect(box, natural.w / natural.h)}
            sourceAspect={natural.w / natural.h}
            targetAspect={targetAspect}
            onCommit={onFocusCommit}
          />
        )}

        {activeOverlays.map((o) =>
          o.kind === "TEXT" ? (
            <TextOverlayEl
              key={o.id}
              overlay={o}
              boxW={box.w}
              boxH={box.h}
              posMs={posMs}
              selected={selectedOverlayId === o.id}
              onSelect={() => onSelectOverlay(o.id)}
              onChange={(patch) => onOverlayChange(o.id, patch)}
            />
          ) : (
            <OverlayImg
              key={o.id}
              overlay={o}
              posMs={posMs}
              boxW={box.w}
              boxH={box.h}
              selected={selectedOverlayId === o.id}
              onSelect={() => onSelectOverlay(o.id)}
              onChange={(patch) => onOverlayChange(o.id, patch)}
            />
          ),
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
              maxWidth: "88%",
              ...(richCss.text as unknown as React.CSSProperties),
              ...((richCss.panel ?? {}) as unknown as React.CSSProperties),
              // keep a legibility floor the burn doesn't need
              fontSize: Math.max(11, richStyle.fontSizePx * scale),
              transform: overlayTransform,
              opacity: cueCss.opacity,
              cursor: "grab",
              touchAction: "none",
              userSelect: "none",
            }}
          >
            {(activeCue!.words as PreviewWord[]).map((w, i) => {
              const anim = captionWordAnim(
                captionAnimId,
                posMs,
                { startMs: w.startMs, endMs: w.endMs, index: i },
                w.text,
              );
              // A real space *between* the spans (not inside them) — an
              // inline-block trims its own edge whitespace but not a sibling
              // text node, and this keeps a soft-wrap opportunity between words.
              const gap = i > 0 ? " " : null;
              if (anim.hidden) {
                return (
                  <Fragment key={w.id ?? i}>
                    {gap}
                    <span style={{ display: "inline-block", opacity: 0 }}>{w.text}</span>
                  </Fragment>
                );
              }
              const manual = wordSpanCss(wordStyles[w.id]);
              const ruleCss = wordEffectCss(
                applyWordRules(captionWordRules, {
                  spoken: posMs >= w.startMs,
                  active: posMs >= w.startMs && posMs < w.endMs,
                }),
              );
              // The explicit colour this word should show, if any.
              const wordColor = anim.highlighted
                ? richStyle.highlightColor
                : ((manual.color ?? ruleCss.color) as string | undefined);
              // On a gradient caption the container clips the gradient with
              // `-webkit-text-fill-color: transparent`; a word with its own
              // colour must override the fill colour AND the clip or it renders
              // hollow / invisible.
              const colorStyle: React.CSSProperties = gradientFill
                ? wordColor
                  ? {
                      color: wordColor,
                      WebkitTextFillColor: wordColor,
                      backgroundImage: "none",
                      backgroundClip: "border-box",
                      WebkitBackgroundClip: "border-box",
                    }
                  : { color: "inherit", WebkitTextFillColor: "inherit" }
                : wordColor
                  ? { color: wordColor }
                  : {};
              // reserve the overflow of a scaled word so it can't collide with
              // the next one (transform:scale doesn't affect layout).
              const sv = Number(anim.css.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
              const scaleMx =
                sv > 1.001
                  ? `${Math.max(0.1, w.text.length * 0.42 * (sv - 1)).toFixed(3)}em`
                  : null;
              return (
                <Fragment key={w.id ?? i}>
                  {gap}
                  <span
                    style={{
                      display: "inline-block",
                      ...(anim.css as unknown as React.CSSProperties),
                      ...(scaleMx ? { marginLeft: scaleMx, marginRight: scaleMx } : {}),
                      ...colorStyle,
                      ...(ruleCss as unknown as React.CSSProperties),
                      ...manual,
                    }}
                  >
                    {anim.visibleText}
                  </span>
                </Fragment>
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
          onChange={(e) => scrub(previewMs(Number(e.target.value)))}
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
 * A freestanding text element previewed over the video. Anchored at its
 * normalised centre point (x, y); drag to reposition. Styled through the same
 * `textStyleToCss` the render will use, so it is WYSIWYG. Rotation / scale /
 * opacity come from the overlay row; size is tuned in the inspector.
 */
function TextOverlayEl({
  overlay,
  boxW,
  boxH,
  posMs,
  selected,
  onSelect,
  onChange,
}: {
  overlay: OverlayView;
  boxW: number;
  boxH: number;
  posMs: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: { x?: number; y?: number }) => void;
}) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; dx: number; dy: number; raf: number } | null>(
    null,
  );

  const style = useMemo(() => {
    const resolved = resolveTextStyle(parseStylePartial(overlay.styleJson));
    const frameScale = (boxH || 480) / 1920;
    return textStyleToCss(resolved, { scale: frameScale * clampScale(overlay.scale) });
  }, [overlay.styleJson, overlay.scale, boxH]);

  const animCss = useMemo(
    () =>
      sampleElementAnim(parseElementAnim(overlay.animationJson), {
        elapsedMs: posMs - (overlay.startMs ?? 0),
        remainingMs: overlay.endMs == null ? null : overlay.endMs - posMs,
      }),
    [overlay.animationJson, overlay.startMs, overlay.endMs, posMs],
  );

  if (boxW === 0) return null;

  const left = clamp01(overlay.x) * boxW;
  const top = clamp01(overlay.y) * boxH;
  const baseTransform = `translate(-50%, -50%) rotate(${overlay.rotation}deg)`;
  const restingTransform =
    animCss.transform && animCss.transform !== "none"
      ? `${baseTransform} ${animCss.transform}`
      : baseTransform;

  const paint = () => {
    const d = drag.current;
    const el = nodeRef.current;
    if (!d || !el) return;
    el.style.transform = `${baseTransform} translate(${d.dx}px, ${d.dy}px)`;
    d.raf = 0;
  };

  function onPointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!selected) onSelect();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, raf: 0 };
    if (nodeRef.current) nodeRef.current.style.willChange = "transform";
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    d.dx = e.clientX - d.startX;
    d.dy = e.clientY - d.startY;
    if (!d.raf) d.raf = requestAnimationFrame(paint);
  }
  function onPointerUp(e: React.PointerEvent) {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    const d = drag.current;
    drag.current = null;
    const el = nodeRef.current;
    if (d?.raf) cancelAnimationFrame(d.raf);
    if (el) {
      el.style.transform = restingTransform;
      el.style.willChange = "";
    }
    if (!d || (Math.abs(d.dx) < 2 && Math.abs(d.dy) < 2)) return;
    onChange({
      x: clamp01(overlay.x + d.dx / Math.max(1, boxW)),
      y: clamp01(overlay.y + d.dy / Math.max(1, boxH)),
    });
  }

  return (
    <div
      ref={nodeRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "absolute",
        left,
        top,
        transform: restingTransform,
        maxWidth: "84%",
        opacity: overlay.opacity * animCss.opacity,
        ...(animCss.filter ? { filter: animCss.filter } : {}),
        cursor: selected ? "move" : "pointer",
        touchAction: "none",
        userSelect: "none",
        outline: selected ? "2px solid rgb(var(--c-accent))" : "1px dashed rgba(255,255,255,0.35)",
        outlineOffset: 3,
      }}
      title={selected ? `${overlay.name} — drag to move` : `${overlay.name} — click to select`}
    >
      <span style={(style.panel ?? undefined) as unknown as React.CSSProperties | undefined}>
        <span
          style={{
            ...(style.text as unknown as React.CSSProperties),
            display: "inline-block",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {overlay.text || "Text"}
        </span>
      </span>
    </div>
  );
}

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
  posMs,
  boxW,
  boxH,
  selected,
  onSelect,
  onChange,
}: {
  overlay: OverlayView;
  posMs: number;
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

  const animCss = useMemo(
    () =>
      sampleElementAnim(parseElementAnim(overlay.animationJson), {
        elapsedMs: posMs - (overlay.startMs ?? 0),
        remainingMs: overlay.endMs == null ? null : overlay.endMs - posMs,
      }),
    [overlay.animationJson, overlay.startMs, overlay.endMs, posMs],
  );

  if (!overlay.url || boxW === 0) return null;

  const w = boxW * 0.3 * clampScale(overlay.scale);
  const h = w * ratio;
  const left = (boxW - w) * clamp01(overlay.x);
  const top = (boxH - h) * clamp01(overlay.y);
  const baseTransform = `rotate(${overlay.rotation}deg)`;
  const restingTransform =
    animCss.transform && animCss.transform !== "none"
      ? `${baseTransform} ${animCss.transform}`
      : baseTransform;

  const paint = () => {
    const d = drag.current;
    const el = nodeRef.current;
    if (!d || !el) return;
    el.style.transform =
      d.mode === "move"
        ? `${restingTransform} translate(${d.dx}px, ${d.dy}px)`
        : `${restingTransform} scale(${d.k})`;
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
        transform: restingTransform,
        opacity: overlay.opacity * animCss.opacity,
        ...(animCss.filter ? { filter: animCss.filter } : {}),
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
