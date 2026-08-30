/**
 * Timeline data model.
 *
 * Everything is milliseconds. The component is source-of-truth agnostic: pass
 * `clips` + `onClipsChange` to drive it from your own store, or omit
 * `onClipsChange` and let it manage an internal copy seeded from `clips`.
 */

export type TrackKind = "video" | "audio" | "overlay" | "text";

export interface TimelineTrack {
  id: string;
  /** Shown in the left gutter, e.g. "V1", "A1". */
  label: string;
  kind: TrackKind;
  muted?: boolean;
  locked?: boolean;
  /** Only one track can be "solo" at a time; others are implicitly silenced. */
  solo?: boolean;
}

export interface TimelineClip {
  id: string;
  trackId: string;
  /** Display name — usually the source filename. */
  name: string;

  /** Position on the timeline. */
  start: number;
  /** Visible length on the timeline (after trimming). */
  duration: number;

  /** In/out points within the *source* media. `sourceOut - sourceIn` need not
   *  equal `duration` once you add speed ramps, but for a plain trim it does. */
  sourceIn: number;
  sourceOut: number;
  /** Full length of the underlying source — trimming can't exceed this. */
  sourceDuration: number;

  /** Optional metadata rendered into the clip label. */
  width?: number;
  height?: number;
  fps?: number;

  /** Filmstrip frames, evenly spaced across the source. Rendered left→right and
   *  cropped as the clip is trimmed. A poster-only clip can pass a single URL. */
  thumbnails?: string[];
  /** Accent bar colour; defaults are derived from the track kind. */
  accent?: string;
}

export interface TimelineProps {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  /** Omit to run uncontrolled (internal copy seeded from `clips`). */
  onClipsChange?: (next: TimelineClip[]) => void;
  onTracksChange?: (next: TimelineTrack[]) => void;
  /** Reorder an overlay lane. When set, overlay track headers show ▲▼ controls. */
  onReorderTrack?: (trackId: string, direction: "up" | "down") => void;
  /** Remove a layer. Offered only for an empty video lane that is not the last. */
  onRemoveTrack?: (trackId: string) => void;

  /** Playhead position in ms. Controlled if provided with `onSeek`. */
  playheadMs?: number;
  onSeek?: (ms: number) => void;

  /** Total timeline length; defaults to the end of the last clip + 5s. */
  durationMs?: number;

  selectedClipId?: string | null;
  onSelectClip?: (id: string | null) => void;

  playing?: boolean;
  onTogglePlay?: () => void;

  /** Edge/playhead snapping. Controlled if paired with `onSnapChange`. */
  snap?: boolean;
  onSnapChange?: (on: boolean) => void;

  /** Cut a clip in two at a timeline ms. Fired by the Split button / `S` key
   *  with the selected clip and the current playhead. */
  onSplit?: (clipId: string, atMs: number) => void;

  /** Undo / redo — wired to the host's history stack. Buttons hide when absent. */
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;

  /** Subtle "Saved" affordance in the toolbar: "saving" | "saved" | "idle". */
  saveState?: "idle" | "saving" | "saved";

  /** Files dropped onto an empty track / the empty state. */
  onImport?: (files: File[]) => void;

  className?: string;
}
