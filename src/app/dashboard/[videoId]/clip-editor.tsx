"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { FocusKeyframe } from "@/lib/focus/keyframes.ts";
import { parseFocusTrack, sampleFocusAt, serializeFocusTrack } from "@/lib/focus/keyframes.ts";
import { RailThumb } from "../rail-thumb";
import { CaptionControls, CAPTION_DEFAULTS, type CaptionConfig } from "./caption-controls";
import { ClipPlayer, type PreviewWord } from "./clip-player";
import { KEYFRAME_SNAP_MS } from "./focus-window";
import { CensorControls, type CensorSettings } from "./censor-controls";
import { VoiceoverPanel, type PreviewLine } from "./voiceover-panel";
import { audioSpans, bleepedIndices, censoredIndices } from "@/lib/censor/detect.ts";
import type { CensorWordOverride, CensorWordOverrides } from "@/lib/censor/overrides.ts";
import { type CaptionCensorMode, maskWords } from "@/lib/censor/mask.ts";
import { EditableTranscript, type TranscriptRow } from "./editable-transcript";
import {
  applyInteriorCuts,
  cutDurationMs,
  cutSpansForWords,
  remapAcrossCuts,
} from "@/lib/sequence/cuts.ts";
import type { ClipPlan } from "@/lib/api/sequence.ts";
import { mapSourceToTimeline, remapWordsToTimeline } from "@/lib/sequence/compose.ts";
import { placeLines } from "@/lib/voiceover/sync.ts";
import type { TranscriptView } from "../editor-pane";
import { TRANSLATE_TARGETS } from "@/lib/translation/targets";
import { OverlayPanel, type OverlayView } from "./overlay-panel";
import type { WordStyle, WordStylePatch } from "./editable-transcript";
import { SequenceEditor } from "./sequence-editor";
import { ASSET_DND_MIME } from "../media-library";
import { useCaptionInsert } from "../caption-insert";

const ASPECTS = [
  ["VERTICAL_9_16", "9:16"],
  ["SQUARE_1_1", "1:1"],
  ["LANDSCAPE_16_9", "16:9"],
  ["PORTRAIT_4_5", "4:5"],
] as const;

/** Target frame aspect (width / height) per stored enum value. */
const ASPECT_RATIOS: Record<string, number> = {
  VERTICAL_9_16: 1080 / 1920,
  SQUARE_1_1: 1,
  LANDSCAPE_16_9: 1920 / 1080,
  PORTRAIT_4_5: 1080 / 1350,
};

/** Display names for transcript language codes. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", nl: "Dutch", ru: "Russian", pl: "Polish", uk: "Ukrainian",
  tr: "Turkish", ar: "Arabic", he: "Hebrew", hi: "Hindi", ja: "Japanese",
  ko: "Korean", zh: "Chinese", vi: "Vietnamese", th: "Thai", id: "Indonesian",
  sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish", el: "Greek",
  cs: "Czech", ro: "Romanian", hu: "Hungarian",
};
const langName = (code: string | null) =>
  code ? (LANGUAGE_NAMES[code] ?? code.toUpperCase()) : "unknown";

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
  focusTrackJson: string | null;
  censorEnabled: boolean;
  censorSensitivity: "LOW" | "MEDIUM" | "HIGH";
  censorCaptionMode: "FULL" | "PARTIAL" | "FIRST" | "CUSTOM";
  censorAudioEnabled: boolean;
  censorAudioMode: "MUTE" | "BEEP" | "TONE";
  censorReplacement: string | null;
  censorAllowList: string[];
  censorDenyList: string[];
  censorExemptWordIds: string[];
  censorForceWordIds: string[];
  censorAudioExemptWordIds: string[];
  censorAudioForceWordIds: string[];
  censorWordOverrides: CensorWordOverrides;
  /** Transcript word ids struck out of the middle; the render cuts them. */
  removedWordIds: string[];
  accepted: boolean;
  savedToProjectId: string | null;
  captions: CaptionConfig | null;
  caption: string | null;
  hook: string | null;
  socialTitle: string | null;
  hashtags: string[];
  reason: string | null;
  thumbnailUrl: string | null;
  render: {
    id: string;
    status: string;
    progress: number;
    downloadUrl: string | null;
    quality: string;
    sizeBytes: number | null;
    durationMs: number | null;
    startedAtMs: number | null;
  } | null;
}

const s = (ms: number) => (ms / 1000).toFixed(1);
/** m:ss.s, for a position measured from the start of the clip. */
const at = (ms: number) => {
  const t = Math.max(0, ms) / 1000;
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
};
/** Order-sensitive equality for the censor word lists. */
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const MIN_LEN_MS = 100;

/** "4.2 MB" / "812 KB" for the export card. */
const fmtBytes = (n: number | null) => {
  if (!n || n <= 0) return null;
  const mb = n / 1_048_576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};
/** "1:05" from a millisecond length. */
const fmtDur = (ms: number) => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
/**
 * Rough "time left" for a render from elapsed time and fractional progress.
 * Null until there's enough signal (a start time + >2% done).
 */
const renderEta = (startedAtMs: number | null, progress: number, nowMs: number | null): string | null => {
  if (startedAtMs == null || nowMs == null || progress <= 0.02 || progress >= 1) return null;
  const remainMs = ((nowMs - startedAtMs) / progress) * (1 - progress);
  if (!Number.isFinite(remainMs) || remainMs <= 0) return null;
  const secs = Math.ceil(remainMs / 1000);
  if (secs < 60) return `~${secs}s left`;
  return `~${Math.floor(secs / 60)}m ${secs % 60}s left`;
};
const qualityLabel = (q: string) =>
  ({ P720: "720p", P1080: "1080p", ORIGINAL: "source quality" })[q] ?? q;
/** Safe download filename from the clip title. */
const fileSlug = (title: string) =>
  title
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "clip";

export function ClipEditor({
  clip,
  videoId,
  transcriptViews,
  selectedTranscript,
  sourceUrl,
  words,
  plan,
  transcript,
  overlays: serverOverlays,
  wordStyles: serverWordStyles,
  projects,
  defaultTimelineOpen = false,
}: {
  clip: ClipData;
  videoId: string;
  transcriptViews: TranscriptView[];
  selectedTranscript: string;
  sourceUrl: string;
  words: PreviewWord[];
  /** The clip's timeline, already resolved to pieces. Null when it has none. */
  plan: ClipPlan | null;
  transcript: TranscriptRow[];
  overlays: OverlayView[];
  wordStyles: Record<string, WordStyle>;
  projects: Array<{ id: string; name: string }>;
  defaultTimelineOpen?: boolean;
}) {
  const router = useRouter();
  const { setFocusedClipId } = useCaptionInsert();

  // Claim "focused clip" so the Add-content rail's Insert-caption targets this
  // one. The first clip claims it on mount as a sensible default.
  useEffect(() => {
    if (defaultTimelineOpen) setFocusedClipId(clip.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sourceLang = transcriptViews.find((t) => t.translatedTo === "")?.language ?? null;

  const [langBusy, setLangBusy] = useState(false);
  const [langError, setLangError] = useState<string | null>(null);

  const showTranscript = useCallback(
    (translatedTo: string) => {
      const params = new URLSearchParams(window.location.search);
      if (translatedTo) params.set("transcript", translatedTo);
      else params.delete("transcript");
      router.push(`/dashboard?${params.toString()}`);
    },
    [router],
  );

  const availableTargets = new Set(
    transcriptViews.filter((t) => t.translatedTo !== "").map((t) => t.translatedTo),
  );

  const pickView = useCallback(
    async (value: string) => {
      setLangError(null);
      if (value === "" || availableTargets.has(value)) {
        showTranscript(value);
        return;
      }
      // Not generated yet — kick off the translation, then switch when it lands.
      setLangBusy(true);
      try {
        const res = await fetch(`/api/videos/${videoId}/translate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target: value }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const started = Date.now();
        const tick = async () => {
          const r = await fetch(`/api/videos/${videoId}`).then((x) => x.json());
          if ((r.translations ?? []).includes(value)) {
            setLangBusy(false);
            showTranscript(value);
          } else if (r.status === "FAILED" || Date.now() - started > 900_000) {
            setLangBusy(false);
            setLangError("Translation didn't finish — try again.");
          } else {
            setTimeout(tick, 3000);
          }
        };
        setTimeout(tick, 3000);
      } catch (e) {
        setLangBusy(false);
        setLangError(e instanceof Error ? e.message : "couldn't start the translation");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoId, showTranscript, transcriptViews],
  );

  const reTranscribe = useCallback(async () => {
    if (
      !window.confirm(
        "Re-transcribe this video? Replaces the current transcript and its AI-suggested clips.",
      )
    )
      return;
    setLangError(null);
    setLangBusy(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/retranscribe`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const started = Date.now();
      const tick = async () => {
        const r = await fetch(`/api/videos/${videoId}`).then((x) => x.json());
        if (r.status === "READY" || r.status === "FAILED" || Date.now() - started > 600_000) {
          setLangBusy(false);
          router.refresh();
        } else setTimeout(tick, 3000);
      };
      setTimeout(tick, 3000);
    } catch {
      setLangBusy(false);
      setLangError("couldn't start re-transcription");
    }
  }, [videoId, router]);

  // Debounced "soft reset": re-run the server components so an edit or delete the
  // user just made is reflected everywhere (the preview, other clips, render
  // state, the rails) without a full reload. Bursts of edits collapse into one.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const softReset = useCallback(() => {
    // Trailing debounce: a burst of edits (slider drags, rapid trims) collapses
    // into one server round-trip instead of one refresh per change.
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 500);
  }, [router]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const [draft, setDraft] = useState(clip);
  const [busy, setBusy] = useState<"save" | "render" | "delete" | "thumb" | "save-to" | null>(null);
  const [focusEditing, setFocusEditing] = useState(false);
  /**
   * Approving an edit for training is deliberately an explicit act. Learning
   * from everything that gets rendered would fill the repository with abandoned
   * experiments; the repository is only useful because it is curated.
   */
  const [trained, setTrained] = useState<string | null>(null);
  const trainOnThis = useCallback(async () => {
    try {
      const res = await fetch(`/api/clips/${clip.id}/train`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { contentType?: string };
      setTrained(body.contentType ?? "UNKNOWN");
    } catch {
      /* the button simply stays available */
    }
  }, [clip.id]);
  /**
   * Captions in the preview are masked exactly as the render will mask them,
   * so what you scrub is what burns — the same rule the animation engine
   * follows. Toggling censoring updates the overlay immediately.
   */
  /**
   * Which transcript words the clip's censor settings would mask right now.
   *
   * Computed from the rows actually on screen so the strike-through always
   * matches what is displayed, and recomputed as the settings change so
   * exempting a word un-marks it immediately.
   */
  const censorCfg = useMemo(
    () => ({
      enabled: draft.censorEnabled,
      sensitivity: draft.censorSensitivity,
      allowList: draft.censorAllowList,
      denyList: draft.censorDenyList,
      exemptWordIds: draft.censorExemptWordIds,
      censorWordIds: draft.censorForceWordIds,
      audioEnabled: draft.censorAudioEnabled,
      audioExemptWordIds: draft.censorAudioExemptWordIds,
      audioForceWordIds: draft.censorAudioForceWordIds,
      wordOverrides: draft.censorWordOverrides,
    }),
    [
      draft.censorEnabled,
      draft.censorSensitivity,
      draft.censorAllowList,
      draft.censorDenyList,
      draft.censorExemptWordIds,
      draft.censorForceWordIds,
      draft.censorAudioEnabled,
      draft.censorAudioExemptWordIds,
      draft.censorAudioForceWordIds,
      draft.censorWordOverrides,
    ],
  );

  /**
   * Exactly what the render will mask — one set, driving both the tick and the
   * strike-through.
   *
   * These were briefly two sets, with the tick computed as if detection were
   * always on so marks could be "prepared" before enabling it. That produced a
   * checkbox that contradicted the strike beside it: with detection off a
   * lexicon word showed ticked but unstruck. Since a hand-picked word now
   * applies whether or not detection is on, there is nothing left to prepare,
   * and one set means the tick can never claim something the render will not do.
   */
  const censoredWordIds = useMemo(() => {
    const flat = transcript.flatMap((r) => r.words);
    if (flat.length === 0) return new Set<string>();
    return new Set([...censoredIndices(flat, censorCfg)].map((i) => flat[i].id));
  }, [transcript, censorCfg]);

  /**
   * Would this occurrence be censored by everything *except* the per-occurrence
   * overrides? Needed to keep the toggle reversible: ticking a word the rules
   * already catch means clearing an exemption, not adding a force-censor, so
   * neither list accumulates entries that no longer do anything.
   *
   * This honours the detection toggle, so with detection off the rules catch
   * nothing and ticking any word records a real hand-picked mark.
   */
  const censoredByRules = useMemo(() => {
    const flat = transcript.flatMap((r) => r.words);
    if (flat.length === 0) return new Set<string>();
    const idx = censoredIndices(flat, {
      enabled: draft.censorEnabled,
      sensitivity: draft.censorSensitivity,
      allowList: draft.censorAllowList,
      denyList: draft.censorDenyList,
    });
    return new Set([...idx].map((i) => flat[i].id));
  }, [
    transcript,
    draft.censorEnabled,
    draft.censorSensitivity,
    draft.censorAllowList,
    draft.censorDenyList,
  ]);

  /**
   * Turn censoring on or off for specific occurrences, on this clip only.
   *
   * Both directions are expressed through the same two id lists, and each is
   * only written to when it actually changes the outcome:
   *   censor   -> drop from exempt; force only if the rules would not catch it
   *   uncensor -> drop from force; exempt only if the rules *would* catch it
   * So a word returns to exactly the state it came from.
   */
  const setWordsCensored = useCallback(
    (wordIds: string[], censored: boolean) => {
      if (wordIds.length === 0) return;
      setDraft((d) => {
        const exempt = new Set(d.censorExemptWordIds);
        const force = new Set(d.censorForceWordIds);
        for (const id of wordIds) {
          if (censored) {
            exempt.delete(id);
            if (!censoredByRules.has(id)) force.add(id);
          } else {
            force.delete(id);
            if (censoredByRules.has(id)) exempt.add(id);
          }
        }
        return { ...d, censorExemptWordIds: [...exempt], censorForceWordIds: [...force] };
      });
    },
    [censoredByRules],
  );

  /**
   * The words the render will bleep. Computed independently of the mask, not
   * filtered from it: the two are separate decisions, so this set can name a
   * word the captions never touch.
   */
  const bleepedWordIds = useMemo(() => {
    const flat = transcript.flatMap((r) => r.words);
    if (flat.length === 0) return new Set<string>();
    return new Set([...bleepedIndices(flat, censorCfg)].map((i) => flat[i].id));
  }, [transcript, censorCfg]);

  /**
   * Turn the bleep on or off for specific occurrences.
   *
   * Mirrors `setWordsCensored`, with the clip-wide `censorAudioEnabled` playing
   * the part the lexicon rules play there: an id is only recorded when it
   * differs from that default, so flipping the clip toggle back leaves no
   * stale overrides behind.
   */
  const setWordsBleeped = useCallback(
    (wordIds: string[], bleeped: boolean) => {
      if (wordIds.length === 0) return;
      setDraft((d) => {
        const exempt = new Set(d.censorAudioExemptWordIds);
        const force = new Set(d.censorAudioForceWordIds);
        for (const id of wordIds) {
          // What the audio would do with no override at all: follow the mask,
          // unless the clip-wide bleep is switched off.
          const byDefault = d.censorAudioEnabled && censoredWordIds.has(id);
          if (bleeped) {
            exempt.delete(id);
            if (!byDefault) force.add(id);
          } else {
            force.delete(id);
            if (byDefault) exempt.add(id);
          }
        }
        return {
          ...d,
          censorAudioExemptWordIds: [...exempt],
          censorAudioForceWordIds: [...force],
        };
      });
    },
    [censoredWordIds],
  );

  /**
   * Strike words out of the middle of the clip, or put them back.
   *
   * Stored as a plain id list rather than as timeline pieces: the cut is
   * derived from the word's own timing at render time, so correcting a
   * transcript timing or re-trimming the clip keeps the cut on its word.
   */
  /**
   * The narration the preview should play, reported by the voiceover panel as
   * it loads. Held here because the panel and the player are siblings, and the
   * panel is the one that already knows.
   */
  const [narration, setNarration] = useState<{ lines: PreviewLine[]; duckDb: number }>({
    lines: [],
    duckDb: 0,
  });
  const onNarrationLines = useCallback(
    (lines: PreviewLine[], duckDb: number) => setNarration({ lines, duckDb }),
    [],
  );


  const cutWordIds = useMemo(() => new Set(draft.removedWordIds), [draft.removedWordIds]);
  /**
   * The stretches the render will drop, for the preview to skip over.
   *
   * Clip-relative, because `words` is: the page hands this component word times
   * already rebased onto the clip. Built by the same function the renderer
   * uses, which is what makes "the preview plays what the export contains" true
   * rather than approximately true.
   */
  /**
   * What the preview should actually play.
   *
   * The timeline's pieces with the struck words taken out — the same two
   * transforms the renderer applies, in the same order, so scrubbing the
   * preview walks the export. A clip with no timeline (or one that is still
   * just its own window) gets a single piece synthesised from the *draft*, so
   * dragging the trim handles is reflected immediately; once the timeline says
   * something of its own, it wins.
   */
  const previewPlan = useMemo(() => {
    const saved = plan?.pieces ?? [];
    const untouched =
      saved.length === 1 &&
      saved[0].sourceVideoId === videoId &&
      saved[0].sourceIn === clip.startMs &&
      saved[0].sourceOut === clip.endMs;
    const base =
      saved.length > 0 && !untouched
        ? saved
        : [
            {
              sourceVideoId: videoId,
              sourceStorageKey: null,
              sourceIn: Math.round(draft.startMs),
              sourceOut: Math.round(draft.endMs),
              timelineStart: 0,
              durationMs: Math.max(1, Math.round(draft.endMs - draft.startMs)),
            },
          ];
    const upper = plan?.layers ?? [];
    if (draft.removedWordIds.length === 0) return { base, layers: upper };
    // Word times arrive rebased onto the clip; cuts are expressed against the
    // source, which is the coordinate the pieces use.
    const inSource = words.map((w) => ({
      ...w,
      startMs: w.startMs + clip.startMs,
      endMs: w.endMs + clip.startMs,
    }));
    const cut = applyInteriorCuts(base, cutSpansForWords(inSource, draft.removedWordIds, videoId));
    return {
      base: cut,
      // A layer sits at a position in the output, so a cut earlier in the clip
      // moves it — the same correction the renderer makes.
      layers: upper.map((l) => ({ ...l, timelineStart: remapAcrossCuts(base, cut, l.timelineStart) })),
    };
  }, [plan, videoId, clip.startMs, clip.endMs, draft.startMs, draft.endMs, draft.removedWordIds, words]);

  /** A playable URL for every source the plan touches. */
  const planSourceUrls = useMemo(
    () => ({ [videoId]: sourceUrl, ...(plan?.sourceUrls ?? {}) }),
    [videoId, sourceUrl, plan],
  );

  /**
   * Narration placed on the preview's timeline.
   *
   * The server hands back the synthesized lines but not where they go: it can
   * only see the saved clip, and the timeline being previewed may have edits it
   * has never been told about. So the anchors are built here, from the same
   * plan the preview plays and through the same `placeLines` the renderer uses
   * — a segment goes wherever its footage went, and one whose footage was cut
   * away yields no anchor at all, exactly as at render time.
   */
  const placedNarration = useMemo(() => {
    if (narration.lines.length === 0) return [];
    const planMs = Math.max(1, previewPlan.base.reduce((e, p) => Math.max(e, p.timelineStart + p.durationMs), 0));
    const anchors = transcript.flatMap((sg, i) => {
      const start = mapSourceToTimeline(previewPlan.base, videoId, sg.startMs);
      if (start === null) return [];
      const end = mapSourceToTimeline(previewPlan.base, videoId, sg.endMs) ?? start;
      return [{ ref: `seg:${i}`, startMs: start, endMs: Math.max(start + 1, end) }];
    });
    const scripted = narration.lines
      .filter((l) => l.ref.startsWith("script:"))
      .map((l, i, all) => {
        const step = planMs / Math.max(1, all.length);
        return { ref: l.ref, startMs: Math.round(i * step), endMs: Math.round((i + 1) * step) };
      });
    const byRef = new Map(narration.lines.map((l) => [l.ref, l.url]));
    return placeLines(
      narration.lines.map((l) => ({ ...l, text: "", audioKey: l.ref })),
      [...anchors, ...scripted],
      { durationMs: planMs },
    ).map((p) => ({
      ref: p.ref,
      startMs: p.startMs,
      playedMs: p.playedMs,
      tempo: p.tempo,
      url: byRef.get(p.ref) ?? "",
    }));
  }, [narration, previewPlan, transcript, videoId]);

  /**
   * The words as the preview timeline sees them.
   *
   * Struck words are gone and everything after a cut has moved up, because they
   * are run through the same `remapWordsToTimeline` the renderer uses on the
   * same plan. Anything timed off the transcript — the caption overlay, the
   * bleeps — has to start from this rather than from the raw clip-relative
   * times, or it fires where the word *used* to be.
   */
  const timelineWords = useMemo(() => {
    const inSource = words.map((w) => ({
      ...w,
      startMs: w.startMs + clip.startMs,
      endMs: w.endMs + clip.startMs,
    }));
    return remapWordsToTimeline(inSource, previewPlan.base, videoId, 0);
  }, [words, clip.startMs, previewPlan, videoId]);

  /**
   * Exactly the stretches the render will bleep, for the preview to bleep too.
   *
   * Built from the same `audioSpans` the renderer calls, on the same config and
   * the same remapped words, so toggling a word or changing the sound is
   * audible immediately instead of being a promise the export keeps later.
   */
  const bleepSpans = useMemo(
    () =>
      audioSpans(timelineWords, censorCfg).map((sp) => ({
        startMs: sp.startMs,
        endMs: sp.endMs,
        mode: sp.audioMode ?? draft.censorAudioMode,
      })),
    [timelineWords, censorCfg, draft.censorAudioMode],
  );
  const setWordsCut = useCallback((wordIds: string[], cut: boolean) => {
    if (wordIds.length === 0) return;
    setDraft((d) => {
      const next = new Set(d.removedWordIds);
      for (const id of wordIds) {
        if (cut) next.add(id);
        else next.delete(id);
      }
      return { ...d, removedWordIds: [...next] };
    });
  }, []);


  /**
   * Set a per-word censor setting on specific occurrences.
   *
   * `null` clears a field, which is not the same as setting it to the clip's
   * current value: cleared means "follow the clip", so a later change to the
   * clip setting still reaches this word. A word whose last field is cleared
   * drops out of the map entirely rather than lingering as `{}`.
   */
  const setWordCensorOptions = useCallback(
    (wordIds: string[], patch: Partial<Record<keyof CensorWordOverride, unknown>>) => {
      if (wordIds.length === 0) return;
      setDraft((d) => {
        const next: CensorWordOverrides = { ...d.censorWordOverrides };
        for (const id of wordIds) {
          const entry: CensorWordOverride = { ...next[id] };
          for (const [key, value] of Object.entries(patch)) {
            if (value == null || value === "") delete entry[key as keyof CensorWordOverride];
            else (entry as Record<string, unknown>)[key] = value;
          }
          if (Object.keys(entry).length === 0) delete next[id];
          else next[id] = entry;
        }
        return { ...d, censorWordOverrides: next };
      });
    },
    [],
  );

  /**
   * The caption text as the player should show it — masked exactly the way the
   * render will mask it.
   *
   * This runs on the real config rather than a simplified one. It used to be
   * built from sensitivity and the term lists alone, gated on the detection
   * toggle, which made the video preview the least truthful surface in the
   * editor: a hand-marked word showed clean while the render masked it, a word
   * rescued with "Keep it" still showed masked, and per-word masks never
   * appeared at all.
   */
  const previewWords = useMemo(() => {
    // Already remapped: struck words are absent and the rest sit where the
    // export will put them, so a cue never describes a render that will not
    // happen.
    const shown = timelineWords;
    const flagged = censoredIndices(shown, censorCfg);
    if (flagged.size === 0) return shown;

    const perWord = new Map<number, { mode?: CaptionCensorMode; replacement?: string | null }>();
    for (const index of flagged) {
      const own = draft.censorWordOverrides[shown[index].id];
      if (own?.captionMode || own?.replacement != null) {
        perWord.set(index, { mode: own.captionMode, replacement: own.replacement });
      }
    }
    return maskWords(
      shown,
      flagged,
      draft.censorCaptionMode,
      draft.censorReplacement ?? undefined,
      perWord,
    );
  }, [
    timelineWords,
    censorCfg,
    draft.censorCaptionMode,
    draft.censorReplacement,
    draft.censorWordOverrides,
  ]);
  const focusTrack = useMemo(
    () => parseFocusTrack(draft.focusTrackJson),
    [draft.focusTrackJson],
  );
  const setFocusTrack = useCallback(
    (next: FocusKeyframe[]) =>
      setDraft((d) => ({ ...d, focusTrackJson: serializeFocusTrack(next) })),
    [],
  );
  /**
   * Auto-key: a drag writes the window at the playhead, replacing a keyframe
   * already sitting there rather than stacking a second one on the same frame.
   */
  const commitFocus = useCallback(
    (kf: FocusKeyframe) => {
      setDraft((d) => {
        const track = parseFocusTrack(d.focusTrackJson);
        const i = track.findIndex((k) => Math.abs(k.atMs - kf.atMs) <= KEYFRAME_SNAP_MS);
        const next = i >= 0 ? track.map((k, j) => (j === i ? { ...k, ...kf, atMs: k.atMs } : k)) : [...track, kf];
        return { ...d, focusTrackJson: serializeFocusTrack(next) };
      });
    },
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  // A seek requested from the transcript (click a word). `n` forces the player's
  // effect to re-run even when the same word is clicked twice.
  const [seekReq, setSeekReq] = useState<{ ms: number; n: number } | null>(null);
  const seekToWord = useCallback(
    (absStartMs: number) => {
      const rel = Math.min(
        Math.max(0, absStartMs - clip.startMs),
        Math.max(0, clip.endMs - clip.startMs - 1),
      );
      setSeekReq({ ms: rel, n: Date.now() });
    },
    [clip.startMs, clip.endMs],
  );
  const [playToggleReq, setPlayToggleReq] = useState<{ n: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(defaultTimelineOpen);
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
        else softReset();
      })
      .catch(() => setOverlayError("couldn't save that change — try again"));
  }, [softReset]);

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
    })
      .then(() => softReset())
      .catch(() => setOverlayError("couldn't reorder — try again"));
  }, [softReset]);

  const deleteOverlayLocal = useCallback((id: string) => {
    setSelectedOverlayId((cur) => (cur === id ? null : cur));
    setOverlays((list) => list.filter((o) => o.id !== id));
    void fetch(`/api/overlays/${id}`, { method: "DELETE" })
      .then(() => softReset())
      .catch(() => {
        setOverlayError("couldn't remove that layer — refresh to retry");
      });
  }, [softReset]);

  // Overlay time windows shared with the timeline editor, so a "Shows from/to"
  // edit here and a trim/move on the Overlays track stay in lock-step.
  const overlayWindows = useMemo(
    () => overlays.map((o) => ({ id: o.id, startMs: o.startMs, endMs: o.endMs })),
    [overlays],
  );
  const applyOverlayTiming = useCallback(
    (id: string, startMs: number, endMs: number) =>
      setOverlays((list) =>
        list.map((o) => (o.id === id ? { ...o, startMs, endMs } : o)),
      ),
    [],
  );
  const removeOverlayLocal = useCallback(
    (id: string) => {
      setSelectedOverlayId((cur) => (cur === id ? null : cur));
      setOverlays((list) => list.filter((o) => o.id !== id));
    },
    [],
  );

  // --- per-word caption styling (the 4th layer: overrides SubtitleConfig for
  // individual words; keyed by word id so text edits keep the styling). ---
  const [wordStyles, setWordStyles] = useState<Record<string, WordStyle>>(serverWordStyles);
  const [selectedWords, setSelectedWords] = useState<Set<string>>(() => new Set());

  /**
   * What the cuts take out, and what cutting the selection would take out on
   * top of it.
   *
   * Measured with the same functions the renderer uses, so the seconds shown
   * here are the seconds the export loses — including the silence either side
   * of a struck word, which is most of the difference on a short one.
   */
  const cutSummary = useMemo(() => {
    const words = transcript.flatMap((r) => r.words);
    const inClip = (w: { startMs: number; endMs: number }) =>
      w.endMs > draft.startMs && w.startMs < draft.endMs;
    const struck = words.filter((w) => cutWordIds.has(w.id) && inClip(w));
    const pending = words.filter(
      (w) => selectedWords.has(w.id) && !cutWordIds.has(w.id) && inClip(w),
    );
    const clipAsOnePiece = [
      {
        sourceVideoId: "self",
        sourceStorageKey: null,
        sourceIn: draft.startMs,
        sourceOut: draft.endMs,
        timelineStart: 0,
        durationMs: draft.endMs - draft.startMs,
      },
    ];
    const lost = (ids: string[]) =>
      cutDurationMs(clipAsOnePiece, cutSpansForWords(words, ids, "self"));
    const removedMs = lost(struck.map((w) => w.id));
    return {
      struck,
      pending,
      removedMs,
      // The extra, not the total: two cuts that merge cost less together than
      // they do apart, and the button should promise the honest number.
      pendingMs: lost([...struck, ...pending].map((w) => w.id)) - removedMs,
    };
  }, [transcript, cutWordIds, selectedWords, draft.startMs, draft.endMs]);
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

  const clipFromSelection = useCallback(
    async (startMs: number, endMs: number) => {
      try {
        const res = await fetch(`/api/videos/${videoId}/clips`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ startMs: Math.round(startMs), endMs: Math.round(endMs) }),
        });
        if (res.ok) {
          setSelectedWords(new Set());
          router.refresh();
        }
      } catch {
        /* ignore */
      }
    },
    [videoId, router],
  );

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
      })
        .then(() => softReset())
        .catch(() => setError("couldn't save caption styling — try again"));
      return sel;
    });
  }, [clip.id, softReset]);

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
      })
        .then(() => softReset())
        .catch(() => setError("couldn't reset caption styling — try again"));
      return sel;
    });
  }, [clip.id, softReset]);
  const [captionsOn, setCaptionsOn] = useState(clip.captions !== null);
  const [captionDraft, setCaptionDraft] = useState<CaptionConfig>(clip.captions ?? CAPTION_DEFAULTS);
  const [saveMenu, setSaveMenu] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

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

  // While a render is in flight, poll for progress and tick a clock for the ETA.
  // `null` on the server / first paint so the ETA can't cause a hydration gap.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    if (!rendering) return;
    setNowMs(Date.now());
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    const poll = setInterval(() => router.refresh(), 2500);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [rendering, router]);

  const dirty =
    draft.title !== clip.title ||
    draft.startMs !== clip.startMs ||
    draft.endMs !== clip.endMs ||
    draft.aspectRatio !== clip.aspectRatio ||
    draft.focalX !== clip.focalX ||
    draft.focalY !== clip.focalY ||
    draft.focusTrackJson !== clip.focusTrackJson ||
    draft.censorEnabled !== clip.censorEnabled ||
    draft.censorSensitivity !== clip.censorSensitivity ||
    draft.censorCaptionMode !== clip.censorCaptionMode ||
    draft.censorAudioEnabled !== clip.censorAudioEnabled ||
    draft.censorAudioMode !== clip.censorAudioMode ||
    draft.censorReplacement !== clip.censorReplacement ||
    !sameList(draft.censorAllowList, clip.censorAllowList) ||
    !sameList(draft.censorDenyList, clip.censorDenyList) ||
    !sameList(draft.censorExemptWordIds, clip.censorExemptWordIds) ||
    !sameList(draft.censorForceWordIds, clip.censorForceWordIds) ||
    !sameList(draft.censorAudioExemptWordIds, clip.censorAudioExemptWordIds) ||
    !sameList(draft.censorAudioForceWordIds, clip.censorAudioForceWordIds) ||
    JSON.stringify(draft.censorWordOverrides) !== JSON.stringify(clip.censorWordOverrides) ||
    !sameList(draft.removedWordIds, clip.removedWordIds) ||
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
        focusTrack: focusTrack.length ? focusTrack : null,
        censorEnabled: draft.censorEnabled,
        censorSensitivity: draft.censorSensitivity,
        censorCaptionMode: draft.censorCaptionMode,
        censorAudioEnabled: draft.censorAudioEnabled,
        censorAudioMode: draft.censorAudioMode,
        censorReplacement: draft.censorReplacement,
        censorAllowList: draft.censorAllowList,
        censorDenyList: draft.censorDenyList,
        censorExemptWordIds: draft.censorExemptWordIds,
        censorForceWordIds: draft.censorForceWordIds,
        censorAudioExemptWordIds: draft.censorAudioExemptWordIds,
        censorAudioForceWordIds: draft.censorAudioForceWordIds,
        censorWordOverrides: draft.censorWordOverrides,
        removedWordIds: draft.removedWordIds,
        accepted: draft.accepted,
      }),
    });
  const renderReq = () => fetch(`/api/clips/${clip.id}/render`, { method: "POST" });

  const save = () => call("save", saveReq);
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
        softReset();
      }
    } catch (err) {
      setOverlayError(err instanceof Error ? err.message : "could not add overlay");
    }
  }

  async function addTextOverlay() {
    setOverlayError(null);
    try {
      const res = await fetch(`/api/clips/${clip.id}/text-overlays`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "New caption" }),
      });
      const created = await res.json().catch(() => null);
      if (!res.ok) throw new Error(created?.error ?? "could not add text");
      if (created?.id) {
        setOverlays((list) => [...list, created as OverlayView]);
        setSelectedOverlayId(created.id);
      }
    } catch (err) {
      setOverlayError(err instanceof Error ? err.message : "could not add text");
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


  // Editing shortcuts, scoped to the clip card the pointer is over so multiple
  // open cards don't all react. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (!cardRef.current?.matches(":hover")) return;
      const clipLen = Math.max(1, clip.endMs - clip.startMs);
      const seek = (deltaMs: number) =>
        setSeekReq({ ms: Math.min(clipLen - 1, Math.max(0, playheadMs + deltaMs)), n: Date.now() });
      switch (e.key) {
        case " ":
          e.preventDefault();
          setPlayToggleReq({ n: Date.now() });
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(e.shiftKey ? -100 : -1000);
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(e.shiftKey ? 100 : 1000);
          break;
        case "i":
        case "I":
          e.preventDefault();
          setStartToPlayhead();
          break;
        case "o":
        case "O":
          e.preventDefault();
          setEndToPlayhead();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadMs, clip.startMs, clip.endMs]);

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
  const eta = clip.render
    ? renderEta(clip.render.startedAtMs, clip.render.progress, nowMs)
    : null;

  return (
    <div
      ref={cardRef}
      onPointerDownCapture={() => setFocusedClipId(clip.id)}
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
        <button
          type="button"
          onClick={() => {
            if (confirmClose) {
              setConfirmClose(false);
              void remove();
            } else {
              setConfirmClose(true);
              setTimeout(() => setConfirmClose(false), 3000);
            }
          }}
          disabled={busy !== null}
          aria-label="Remove this clip"
          title={confirmClose ? "Click again to remove this clip" : "Remove this clip"}
          className={`btn btn-ghost btn-sm mt-1 w-7 shrink-0 ${
            confirmClose ? "bg-danger/15 text-danger" : "text-muted hover:text-danger"
          }`}
        >
          {busy === "delete" ? "…" : "✕"}
        </button>
        <RailThumb
          url={clip.thumbnailUrl}
          className={`rounded-lg ${collapsed ? "h-9 w-16" : "h-16 w-28"}`}
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
            disabled={busy !== null}
            aria-haspopup="menu"
            aria-expanded={saveMenu}
            className={`btn btn-ghost btn-sm ${savedProject ? "text-accent" : ""}`}
          >
            {busy === "save-to" ? "…" : savedProject ? `✓ ${savedProject.name}` : "Save / export ▸"}
          </button>
          {saveMenu && (
            <div className="menu right-0 top-9" role="menu">
              <p className="px-2 py-1 text-xs text-muted">Save to your computer</p>
              {clip.render?.downloadUrl ? (
                <a
                  role="menuitem"
                  href={clip.render.downloadUrl}
                  download={`${fileSlug(draft.title)}.mp4`}
                  onClick={() => setSaveMenu(false)}
                >
                  ⬇ Download MP4
                </a>
              ) : (
                <button
                  role="menuitem"
                  disabled={busy !== null || rendering}
                  onClick={() => {
                    setSaveMenu(false);
                    void saveAndRender();
                  }}
                >
                  ⬇{" "}
                  {rendering
                    ? `Rendering… ${pct}%${eta ? ` · ${eta}` : ""}`
                    : "Render & download MP4"}
                </button>
              )}
              <div className="my-1 border-t border-border" />
              <p className="px-2 py-1 text-xs text-muted">Save a copy to a project</p>
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

      {clip.origin === "AI_SUGGESTED" &&
        (clip.socialTitle || clip.caption || clip.hashtags.length > 0 || clip.hook) && (
          <details className="rounded-xl border border-border bg-surface-raised p-3 text-sm">
            <summary className="cursor-pointer select-none font-semibold">
              Post copy
              {clip.score !== null && (
                <span className="ml-2 text-xs font-normal text-muted">
                  score {clip.score.toFixed(2)}
                </span>
              )}
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {clip.reason && <p className="text-xs italic text-muted">{clip.reason}</p>}
              {[
                ["Title", clip.socialTitle],
                ["Hook", clip.hook],
                ["Caption", clip.caption],
                ["Hashtags", clip.hashtags.length ? clip.hashtags.join(" ") : null],
              ].map(([label, value]) =>
                value ? (
                  <div key={label} className="flex items-start gap-2">
                    <span className="mt-0.5 w-16 shrink-0 text-xs font-medium text-muted">{label}</span>
                    <span className="min-w-0 flex-1 break-words">{value}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm shrink-0"
                      onClick={() => void navigator.clipboard.writeText(value).catch(() => {})}
                    >
                      Copy
                    </button>
                  </div>
                ) : null,
              )}
            </div>
          </details>
        )}

      {/* Export — render this clip to an MP4 and save it anywhere on your computer */}
      <div className="rounded-xl border border-border bg-surface-raised p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span aria-hidden>⬇</span> Export clip
          </span>
          {clip.render?.downloadUrl && !rendering && (
            <span className="text-xs text-muted">
              {[
                qualityLabel(clip.render.quality),
                fmtDur(clip.render.durationMs ?? clip.endMs - clip.startMs),
                fmtBytes(clip.render.sizeBytes),
              ]
                .filter(Boolean)
                .join("  ·  ")}
            </span>
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {rendering ? (
            <>
              <div className="h-2 min-w-[140px] flex-1 overflow-hidden rounded-full bg-surface">
                <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
              </div>
              <span className="font-mono text-xs tabular-nums text-muted">
                Rendering… {pct}%{eta ? ` · ${eta}` : ""}
              </span>
            </>
          ) : clip.render?.downloadUrl ? (
            <>
              <a
                href={clip.render.downloadUrl}
                download={`${fileSlug(draft.title)}.mp4`}
                className="btn btn-primary"
              >
                ⬇ Download MP4
              </a>
              <button
                onClick={saveAndRender}
                disabled={busy !== null}
                className="btn btn-ghost btn-sm"
              >
                {dirty ? "Re-render with changes" : "Re-render"}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={saveAndRender}
                disabled={busy !== null}
                className="btn btn-primary"
              >
                {busy === "render" || busy === "save" ? "Starting…" : "Render & download"}
              </button>
              <span className="text-xs text-muted">
                Builds a shareable MP4 you can save anywhere on your computer.
              </span>
            </>
          )}
        </div>

        {clip.render && !rendering && !clip.render.downloadUrl && (
          <p className="mt-2 text-xs text-danger">
            The last render {clip.render.status.toLowerCase()} — try again.
          </p>
        )}
      </div>

      <ClipPlayer
        sourceUrl={sourceUrl}
        startMs={clip.startMs}
        endMs={clip.endMs}
        words={previewWords}
        captionsOn={captionsOn}
        caption={captionDraft}
        wordStyles={wordStyles}
        plan={previewPlan.base}
        planLayers={previewPlan.layers}
        planSourceUrls={planSourceUrls}
        voiceover={
          placedNarration.length > 0
            ? { duckDb: narration.duckDb, lines: placedNarration }
            : null
        }
        bleeps={bleepSpans}
        renderUrl={clip.render?.downloadUrl ?? null}
        seekToMs={seekReq}
        togglePlayReq={playToggleReq}
        overlays={overlays}
        selectedOverlayId={selectedOverlayId}
        onSelectOverlay={setSelectedOverlayId}
        onOverlayChange={editOverlay}
        onPlayhead={setPlayheadMs}
        onSourceError={softReset}
        onCaptionLayout={onCaptionLayout}
        focusTrack={focusTrack}
        targetAspect={ASPECT_RATIOS[draft.aspectRatio] ?? 1080 / 1920}
        focusEditing={focusEditing}
        onFocusCommit={commitFocus}
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
          onClick={() => setFocusEditing((v) => !v)}
          aria-pressed={focusEditing}
          className={`pill ${focusEditing ? "border-accent/50 text-accent" : ""}`}
          title="Drag a crop window over the preview and keyframe it over time"
        >
          {focusEditing ? "✓ capture window" : "capture window"}
          {focusTrack.length > 0 && !focusEditing ? ` · ${focusTrack.length}` : ""}
        </button>
        <button
          type="button"
          onClick={() => setDraft({ ...draft, accepted: !draft.accepted })}
          aria-pressed={draft.accepted}
          className={`pill ${draft.accepted ? "border-accent/50 text-accent" : ""}`}
        >
          {draft.accepted ? "✓ accepted" : "mark accepted"}
        </button>
        <button
          type="button"
          onClick={trainOnThis}
          disabled={trained !== null}
          className={`pill ${trained ? "border-accent/50 text-accent" : ""}`}
          title="Add this edit to the training repository so the editor learns your style from it"
        >
          {trained === null ? "🧠 train on this" : `🧠 learning from this${trained === "UNKNOWN" ? "" : ` · ${trained.toLowerCase()}`}`}
        </button>
      </div>

      {focusEditing && (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-raised px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs text-muted">
              Drag the box to move it, the corners to zoom. Each drag keyframes the window at the
              playhead.
            </span>
            <button
              type="button"
              className="btn btn-sm ml-auto"
              onClick={() =>
                commitFocus({
                  atMs: Math.round(playheadMs),
                  ...sampleFocusAt(focusTrack, playheadMs),
                })
              }
            >
              + Keyframe here
            </button>
            {focusTrack.length > 0 && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => setFocusTrack([])}
              >
                Clear window
              </button>
            )}
          </div>

          {focusTrack.length === 0 ? (
            <p className="text-xs text-muted">
              No window yet — the clip reframes with its focal point, or a detected face. Drag the
              box to start one.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {focusTrack.map((k, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm font-mono tabular-nums"
                    onClick={() => setSeekReq({ ms: k.atMs, n: Date.now() })}
                    title="Jump to this keyframe"
                  >
                    {(k.atMs / 1000).toFixed(2)}s
                  </button>
                  <span className="font-mono tabular-nums text-muted">
                    {k.scale.toFixed(2)}× · {k.x.toFixed(2)},{k.y.toFixed(2)}
                  </span>
                  <label className="flex items-center gap-1">
                    ease
                    <select
                      value={k.ease ?? "inOut"}
                      onChange={(e) =>
                        setFocusTrack(
                          focusTrack.map((x, j) =>
                            j === i ? { ...x, ease: e.target.value as FocusKeyframe["ease"] } : x,
                          ),
                        )
                      }
                      className="field py-0.5"
                    >
                      {(["inOut", "linear", "in", "out", "spring"] as const).map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => setFocusTrack(focusTrack.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <VoiceoverPanel clipId={clip.id} onLines={onNarrationLines} />

      <div className="rounded-lg bg-surface-raised px-3 py-2">
        <CensorControls
          value={draft as CensorSettings}
          words={words}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        />
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
        onAddText={addTextOverlay}
      />
      {overlayError && <p className="text-sm text-danger">{overlayError}</p>}

      {/* Non-linear timeline. Opening it once creates the sequence, seeded with
          this clip's window; a clip whose timeline is never opened renders
          exactly as before. */}
      <div className="rounded-xl border border-accent/40 bg-surface-raised">
        <button
          type="button"
          onClick={() => setTimelineOpen((v) => !v)}
          aria-expanded={timelineOpen}
          className="flex w-full items-center gap-2 rounded-t-xl px-3 py-2.5 text-sm font-semibold text-accent hover:bg-accent/5"
        >
          <span
            className={`inline-block transition-transform ${timelineOpen ? "rotate-90" : ""}`}
          >
            ▸
          </span>
          Timeline — split, trim &amp; rearrange this clip into pieces
          {/* A cut is the one timeline edit whose effect is visible from
              outside the panel — the export is shorter than the handles say —
              so the closed header has to admit to it. */}
          {!timelineOpen && cutSummary.struck.length > 0 && (
            <span className="chip">
              ✂ {cutSummary.struck.length} cut · −{s(cutSummary.removedMs)}s
            </span>
          )}
          <span className="ml-auto text-xs font-normal text-muted">
            {timelineOpen ? "hide" : "open editor"}
          </span>
        </button>
        {timelineOpen && (
          <div className="border-t border-border p-3">
            {/* Pieces on a lane play end to end, so the export is their sum:
                trimming one shortens the video, and dropping media in makes it
                longer. Worth saying once, because a timeline that only reorders
                within a fixed length is the more common convention. */}
            <p className="mb-2 text-xs text-muted">
              Pieces on a layer play one after another — trimming one shortens the
              export, and dropping media in makes it longer.
            </p>

            {/* Interior cuts: the other half of trimming. The handles on a piece
                shorten it from its ends; this takes words out of the middle and
                closes the clip up over them. It belongs in this panel rather
                than beside the censor controls because it changes how long the
                export is — censoring never does. */}
            <div className="mb-3 rounded-lg border border-border bg-surface px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  Cut words
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={cutSummary.pending.length === 0}
                  title={
                    cutSummary.pending.length === 0
                      ? "Select words in the transcript below, then cut them out of the middle"
                      : "Remove these words and close the clip up over them"
                  }
                  onClick={() =>
                    setWordsCut(
                      cutSummary.pending.map((w) => w.id),
                      true,
                    )
                  }
                >
                  ✂ Cut{" "}
                  {cutSummary.pending.length === 0
                    ? "selected words"
                    : `${cutSummary.pending.length} selected`}
                  {cutSummary.pendingMs > 0 && ` (−${s(cutSummary.pendingMs)}s)`}
                </button>
                <span className="min-w-0 flex-1 text-xs text-muted">
                  {cutSummary.struck.length === 0
                    ? "Nothing cut — the clip plays straight through."
                    : `${cutSummary.struck.length} word${
                        cutSummary.struck.length === 1 ? "" : "s"
                      } cut · ${s(cutSummary.removedMs)}s shorter`}
                </span>
                {cutSummary.struck.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setWordsCut(
                        cutSummary.struck.map((w) => w.id),
                        false,
                      )
                    }
                  >
                    Restore all
                  </button>
                )}
              </div>
              {cutSummary.struck.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {cutSummary.struck.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      title="Put this word back"
                      onClick={() => setWordsCut([w.id], false)}
                      className="chip group hover:text-danger"
                    >
                      <span className="tabular-nums opacity-70">{at(w.startMs - draft.startMs)}</span>
                      <span className="line-through decoration-1">{w.text}</span>
                      <span aria-hidden className="opacity-60 group-hover:opacity-100">
                        ✕
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <SequenceEditor
              clipId={clip.id}
              followPlayheadMs={playheadMs}
              onScrub={(ms) => setSeekReq({ ms, n: Date.now() })}
              seekToMs={seekReq}
              overlayWindows={overlayWindows}
              onOverlayTiming={applyOverlayTiming}
              onOverlayDeleted={removeOverlayLocal}
              onOverlayReorder={reorderOverlayLocal}
              onChanged={softReset}
            />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="min-w-0 flex-1 text-xs font-medium text-muted">
            Transcript for this clip — click a word to jump the preview there, double-click to fix a
            typo, or select words to colour / bold them as captions
          </p>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <span>Show in</span>
            <select
              className="field h-7 py-0 text-xs"
              disabled={langBusy}
              value={selectedTranscript}
              onChange={(e) => void pickView(e.target.value)}
            >
              <option value="">Original ({langName(sourceLang)})</option>
              {TRANSLATE_TARGETS.filter((c) => c !== sourceLang).map((code) => (
                <option key={code} value={code}>
                  {langName(code)}
                  {availableTargets.has(code) ? "" : " — translate"}
                </option>
              ))}
            </select>
          </label>
          {langBusy && <span className="text-xs text-accent">Translating…</span>}
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="Copy the transcript as plain text"
              onClick={async () => {
                try {
                  const r = await fetch(
                    `/api/videos/${videoId}/transcript?format=txt&lang=${selectedTranscript}`,
                  );
                  if (r.ok) await navigator.clipboard.writeText(await r.text());
                } catch {
                  /* clipboard blocked */
                }
              }}
            >
              Copy
            </button>
            {(["srt", "vtt", "txt"] as const).map((f) => (
              <a
                key={f}
                className="btn btn-ghost btn-sm"
                href={`/api/videos/${videoId}/transcript?format=${f}&lang=${selectedTranscript}`}
                download
              >
                .{f}
              </a>
            ))}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={langBusy}
              title="Re-run transcription with the project's current terms"
              onClick={() => void reTranscribe()}
            >
              Re-transcribe
            </button>
          </span>
        </div>
        {langError && <p className="text-xs text-danger">{langError}</p>}
        <EditableTranscript
          rows={transcript}
          onClipFromSelection={clipFromSelection}
          styles={wordStyles}
          selectedIds={selectedWords}
          onToggleSelect={toggleWordSelect}
          onApplyStyle={applyWordStyle}
          onReset={resetWordStyle}
          onClearSelection={clearWordSelection}
          onSeek={seekToWord}
          censoredIds={censoredWordIds}
          cutIds={cutWordIds}
          onSetCut={setWordsCut}
          audioCensored={draft.censorAudioEnabled}
          onSetAudioCensored={(on) => setDraft((d) => ({ ...d, censorAudioEnabled: on }))}
          bleepedIds={bleepedWordIds}
          onSetBleeped={setWordsBleeped}
          wordOverrides={draft.censorWordOverrides}
          clipAudioMode={draft.censorAudioMode}
          clipCaptionMode={draft.censorCaptionMode}
          clipReplacement={draft.censorReplacement}
          onSetWordCensorOptions={setWordCensorOptions}
          clipStartMs={draft.startMs}
          clipEndMs={draft.endMs}
          onSetCensored={setWordsCensored}
        />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button onClick={save} disabled={!dirty || busy !== null} className="btn btn-primary">
          {busy === "save" ? "…" : "Save"}
        </button>
        {dirty && <span className="text-xs text-muted">Unsaved edits</span>}
        <span className="ml-auto text-xs text-muted">✕ (top-left) removes this clip</span>
      </div>
      </>
      )}
    </div>
  );
}
