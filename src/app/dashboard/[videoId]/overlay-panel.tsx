"use client";

import { memo } from "react";

export interface OverlayView {
  id: string;
  clipId: string;
  assetId: string | null;
  kind: string;
  name: string;
  url: string | null;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  startMs: number | null;
  endMs: number | null;
  zIndex: number;
  hidden: boolean;
}

const secStr = (ms: number | null) => (ms == null ? "" : (ms / 1000).toFixed(1));
const toMs = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
};

/**
 * The clip's layer strip: every dropped image / GIF, stacked top-to-bottom.
 * Purely presentational — every change is handed up via `onEdit` / `onReorder` /
 * `onDelete`, which the editor applies optimistically and writes in the
 * background, so dragging a slider here is instant.
 */
export const OverlayPanel = memo(function OverlayPanel({
  overlays,
  clipLenMs,
  playheadMs,
  selectedId,
  onSelect,
  onEdit,
  onReorder,
  onDelete,
}: {
  overlays: OverlayView[];
  clipLenMs: number;
  playheadMs: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onEdit: (id: string, patch: Record<string, unknown>, opts?: { coalesceMs?: number }) => void;
  onReorder: (id: string, direction: "up" | "down") => void;
  onDelete: (id: string) => void;
}) {
  // Top layer first — matches "what's on top" and the canvas stacking.
  const ordered = [...overlays].sort((a, b) => b.zIndex - a.zIndex);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted">
        Layers{overlays.length ? ` (${overlays.length})` : ""} — drag media from the library onto
        this clip
      </p>

      {ordered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted">
          Drop an image or GIF here, then drag it into place on the preview
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {ordered.map((o, i) => {
            const selected = selectedId === o.id;
            return (
              <li
                key={o.id}
                onClick={() => onSelect(selected ? null : o.id)}
                className={`cursor-pointer rounded-lg border bg-surface-raised transition-colors ${
                  selected ? "border-accent ring-1 ring-accent" : "border-border hover:border-elevated-hover"
                } ${o.hidden ? "opacity-50" : ""}`}
              >
                {/* compact row */}
                <div className="flex items-center gap-2 p-2 text-xs">
                  <button
                    type="button"
                    aria-label={o.hidden ? "Show layer" : "Hide layer"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(o.id, { hidden: !o.hidden });
                    }}
                    className="shrink-0 text-sm text-muted hover:text-text"
                  >
                    {o.hidden ? "🚫" : "👁"}
                  </button>
                  <div className="flex h-8 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-surface">
                    {o.url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
                      <img src={o.url} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <span className="text-muted">🖼</span>
                    )}
                  </div>
                  <span className="min-w-0 flex-1 truncate font-medium" title={o.name}>
                    {o.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label="Bring forward"
                      disabled={i === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        onReorder(o.id, "up");
                      }}
                      className="btn btn-ghost btn-sm px-1 disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label="Send backward"
                      disabled={i === ordered.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onReorder(o.id, "down");
                      }}
                      className="btn btn-ghost btn-sm px-1 disabled:opacity-30"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      aria-label="Remove layer"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(o.id);
                      }}
                      className="btn btn-ghost btn-sm px-1 text-muted hover:text-danger"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* expanded controls for the selected layer */}
                {selected && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-2 py-2 text-xs"
                  >
                    <span className="text-muted">Shows</span>
                    <label className="flex items-center gap-1">
                      from
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        defaultValue={secStr(o.startMs)}
                        placeholder="0"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                        onBlur={(e) => {
                          const ms = toMs(e.target.value);
                          if (ms !== o.startMs) onEdit(o.id, { startMs: ms });
                        }}
                        className="field w-16 font-mono tabular-nums"
                      />
                    </label>
                    <button
                      type="button"
                      title="Set to playhead"
                      onClick={() => onEdit(o.id, { startMs: Math.min(playheadMs, clipLenMs - 1) })}
                      className="btn btn-ghost btn-sm"
                    >
                      ⇤
                    </button>
                    <label className="flex items-center gap-1">
                      to
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        defaultValue={secStr(o.endMs)}
                        placeholder={(clipLenMs / 1000).toFixed(1)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                        onBlur={(e) => {
                          const ms = toMs(e.target.value);
                          if (ms !== o.endMs) onEdit(o.id, { endMs: ms });
                        }}
                        className="field w-16 font-mono tabular-nums"
                      />
                    </label>
                    <button
                      type="button"
                      title="Set to playhead"
                      onClick={() => onEdit(o.id, { endMs: Math.max(1, playheadMs) })}
                      className="btn btn-ghost btn-sm"
                    >
                      ⇥
                    </button>

                    <span className="ml-1 text-muted">Size</span>
                    <input
                      type="range"
                      min={0.05}
                      max={2}
                      step={0.02}
                      value={o.scale}
                      onChange={(e) => onEdit(o.id, { scale: Number(e.target.value) }, { coalesceMs: 200 })}
                      className="w-20"
                    />
                    <span className="text-muted">Opacity</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={o.opacity}
                      onChange={(e) => onEdit(o.id, { opacity: Number(e.target.value) }, { coalesceMs: 200 })}
                      className="w-20"
                    />
                    <span className="text-[10px] text-muted">
                      drag the image on the preview to move it
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
