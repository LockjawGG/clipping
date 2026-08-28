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

const itemToClip = (it: SequenceItemView): TimelineClip => ({
  id: it.id,
  trackId: it.trackId,
  name: it.name,
  start: it.timelineStart,
  duration: Math.max(1, it.sourceOut - it.sourceIn),
  sourceIn: it.sourceIn,
  sourceOut: it.sourceOut,
  sourceDuration: it.sourceDurationMs || it.sourceOut,
});

const trackToTrack = (t: SequenceView["tracks"][number]): TimelineTrack => ({
  id: t.id,
  label: t.name,
  kind: t.kind.toLowerCase() as TimelineTrack["kind"],
  muted: t.muted,
  locked: t.locked,
});

export function SequenceEditor({ clipId }: { clipId: string }) {
  const [seq, setSeq] = useState<SequenceView | null>(null);
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [save, setSave] = useState<"idle" | "saving" | "saved">("idle");

  // per-item coalesced PATCH (move/trim fire many times during a drag)
  const pending = useRef(new Map<string, Record<string, unknown>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const hydrate = useCallback((v: SequenceView) => {
    setSeq(v);
    setClips(v.items.map(itemToClip));
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

  const flush = useCallback((id: string) => {
    const body = pending.current.get(id);
    pending.current.delete(id);
    timers.current.delete(id);
    if (!body || Object.keys(body).length === 0) return;
    setSave("saving");
    void fetch(`/api/sequence-items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        setSave("saved");
        setTimeout(() => setSave("idle"), 1500);
      })
      .catch(() => setError("a change didn't save — try again"));
  }, []);

  /** The component hands us the whole array on any move / trim / delete. */
  const onClipsChange = useCallback(
    (next: TimelineClip[]) => {
      const prevById = new Map(clips.map((c) => [c.id, c]));
      const nextIds = new Set(next.map((c) => c.id));

      // deletions
      for (const c of clips) {
        if (!nextIds.has(c.id)) {
          setSave("saving");
          void fetch(`/api/sequence-items/${c.id}`, { method: "DELETE" })
            .then((r) => {
              setSave(r.ok ? "saved" : "idle");
              if (r.ok) setTimeout(() => setSave("idle"), 1500);
            })
            .catch(() => setError("delete didn't save"));
        }
      }

      // moves / trims -> coalesced PATCH
      for (const nc of next) {
        const oc = prevById.get(nc.id);
        if (!oc) continue;
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

      setClips(next);
    },
    [clips, flush],
  );

  const onSplit = useCallback(
    async (id: string, atMs: number) => {
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
      } catch (e) {
        setError(e instanceof Error ? e.message : "split failed");
        setSave("idle");
      }
    },
    [load],
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

  return (
    <div className="flex flex-col gap-1.5">
      <Timeline
        className="h-[300px]"
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
        onSplit={(id, atMs) => void onSplit(id, atMs)}
        saveState={save}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <p className="text-[11px] text-muted">
        Output {seq.width}×{seq.height} · {seq.fps}fps · drag to move, drag an edge to trim, S to
        split at the playhead, Del to remove. Non-destructive — the source clip is untouched.
      </p>
    </div>
  );
}
