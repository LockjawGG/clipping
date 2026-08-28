"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface AssetView {
  id: string;
  kind: "IMAGE" | "GIF" | "AUDIO" | "SFX";
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  favorited: boolean;
  createdAt: string;
  url: string | null;
}

/** MIME type carried on a drag so a clip can accept a library asset as an overlay. */
export const ASSET_DND_MIME = "application/x-clipper-asset";

const TABS = ["All", "Image", "GIF", "Audio", "SFX", "★"] as const;
type Tab = (typeof TABS)[number];

const KIND_SWAP: Record<AssetView["kind"], AssetView["kind"]> = {
  IMAGE: "GIF",
  GIF: "IMAGE",
  AUDIO: "SFX",
  SFX: "AUDIO",
};
const isAudio = (k: AssetView["kind"]) => k === "AUDIO" || k === "SFX";

const kindOf = (file: File): AssetView["kind"] => {
  if (file.type === "image/gif" || /\.gif$/i.test(file.name)) return "GIF";
  if (file.type.startsWith("image/")) return "IMAGE";
  return "AUDIO";
};

function fmtSize(n: number | null) {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDur(ms: number | null) {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Measure intrinsic dimensions / duration client-side before confirming.
 * Races a 3s timeout so a codec the browser can't decode never hangs the upload.
 */
function probe(
  file: File,
  kind: AssetView["kind"],
): Promise<{ width?: number; height?: number; durationMs?: number }> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { width?: number; height?: number; durationMs?: number }) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => done({}), 3000);
    const finish = (v: { width?: number; height?: number; durationMs?: number }) => {
      clearTimeout(timer);
      done(v);
    };
    if (isAudio(kind)) {
      const a = document.createElement("audio");
      a.preload = "metadata";
      a.onloadedmetadata = () =>
        finish({ durationMs: Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : undefined });
      a.onerror = () => finish({});
      a.src = url;
    } else {
      const img = new Image();
      img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => finish({});
      img.src = url;
    }
  });
}

export function MediaLibrary({ projectId, assets }: { projectId: string; assets: AssetView[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("All");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(0);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  // Rename / favorite / category / delete are applied here first and written in
  // the background, so the grid never waits on a server round-trip. Re-seed
  // only when the set of asset ids changes (an upload, or a switch of project).
  const [items, setItems] = useState<AssetView[]>(assets);
  const seededIds = assets.map((a) => a.id).join(",");
  const lastSeeded = useRef(seededIds);
  if (seededIds !== lastSeeded.current) {
    lastSeeded.current = seededIds;
    setItems(assets);
  }

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((a) => {
      if (tab === "★" && !a.favorited) return false;
      if (tab !== "All" && tab !== "★" && a.kind !== tab.toUpperCase()) return false;
      if (term && !a.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [items, tab, q]);

  async function uploadOne(file: File) {
    const kind = kindOf(file);
    const dims = await probe(file, kind);
    const createRes = await fetch("/api/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        kind,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    });
    if (!createRes.ok) {
      throw new Error((await createRes.json().catch(() => ({}))).error ?? `create failed (${createRes.status})`);
    }
    const { assetId, upload } = await createRes.json();
    const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file });
    if (!put.ok) throw new Error(`upload failed (${put.status})`);
    const confirm = await fetch(`/api/assets/${assetId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dims),
    });
    if (!confirm.ok) throw new Error(`confirm failed (${confirm.status})`);
  }

  async function onFiles(files: File[]) {
    const usable = files.filter((f) => f.size > 0);
    if (usable.length === 0) return;
    setError(null);
    setBusy(usable.length);
    const failed: string[] = [];
    try {
      for (const file of usable) {
        try {
          await uploadOne(file);
        } catch (e) {
          failed.push(`${file.name}: ${e instanceof Error ? e.message : "failed"}`);
        } finally {
          setBusy((n) => Math.max(0, n - 1));
        }
      }
      if (failed.length) setError(failed.join("  •  "));
    } finally {
      setBusy(0);
      router.refresh();
    }
  }

  /** Optimistic asset edit — update the grid now, save in the background. */
  function patch(id: string, body: { name?: string; favorite?: boolean; kind?: AssetView["kind"] }) {
    setError(null);
    setItems((list) =>
      list.map((a) =>
        a.id === id
          ? {
              ...a,
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.favorite !== undefined ? { favorited: body.favorite } : {}),
              ...(body.kind !== undefined ? { kind: body.kind } : {}),
            }
          : a,
      ),
    );
    void fetch(`/api/assets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) setError("couldn't save that change — try again");
      })
      .catch(() => setError("couldn't save that change — try again"));
  }

  function remove(id: string) {
    setError(null);
    const snapshot = items;
    setItems((list) => list.filter((a) => a.id !== id));
    void fetch(`/api/assets/${id}`, { method: "DELETE" })
      .then((r) => {
        if (!r.ok) {
          setItems(snapshot);
          setError("could not delete that item");
        }
      })
      .catch(() => {
        setItems(snapshot);
        setError("could not delete that item");
      });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropping(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) void onFiles(files);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-4">
      <div className="flex items-center gap-2 pt-3">
        <button className="btn btn-primary btn-sm flex-1" onClick={() => inputRef.current?.click()}>
          {busy ? `Uploading ${busy}…` : "+ Add media"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept="image/*,audio/*,.gif"
          onChange={(e) => {
            // Copy the FileList now — clearing .value below empties the live list.
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            void onFiles(picked);
          }}
        />
      </div>

      <input
        className="field w-full"
        placeholder="Search media"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
              tab === t ? "bg-accent text-accent-fg" : "bg-surface-raised text-muted hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDropping(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDropping(false);
        }}
        onDrop={onDrop}
        className={`grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto rounded-lg pr-1 transition-colors ${
          dropping ? "outline-2 outline-dashed outline-accent" : "outline-0"
        }`}
      >
        {shown.length === 0 && (
          <p className="col-span-2 pt-2 text-xs text-muted">
            {assets.length === 0
              ? "No media yet — click “Add media” or drop images, GIFs or audio here."
              : "Nothing matches."}
          </p>
        )}
        {shown.map((a) => (
          <MediaCard
            key={a.id}
            a={a}
            renaming={renaming === a.id}
            onRename={(name) => {
              setRenaming(null);
              if (name && name !== a.name) void patch(a.id, { name });
            }}
            onStartRename={() => setRenaming(a.id)}
            onCancelRename={() => setRenaming(null)}
            onFavorite={() => void patch(a.id, { favorite: !a.favorited })}
            onSwapKind={() => void patch(a.id, { kind: KIND_SWAP[a.kind] })}
            onDelete={() => void remove(a.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MediaCard({
  a,
  renaming,
  onRename,
  onStartRename,
  onCancelRename,
  onFavorite,
  onSwapKind,
  onDelete,
}: {
  a: AssetView;
  renaming: boolean;
  onRename: (name: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onFavorite: () => void;
  onSwapKind: () => void;
  onDelete: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const audio = isAudio(a.kind);

  return (
    <div
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(
          ASSET_DND_MIME,
          JSON.stringify({ id: a.id, kind: a.kind, name: a.name, url: a.url }),
        );
      }}
      className="group relative flex cursor-grab flex-col overflow-hidden rounded-lg border border-border bg-surface active:cursor-grabbing"
      title={`${a.name} — drag onto a clip`}
    >
      <div className="flex aspect-video items-center justify-center bg-surface-raised">
        {audio || broken || !a.url ? (
          <span className="text-2xl text-muted">{audio ? "♪" : "🖼"}</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
          <img
            src={a.url}
            alt=""
            draggable={false}
            onError={() => setBroken(true)}
            className="h-full w-full object-contain"
          />
        )}
      </div>

      <div className="flex items-center gap-1 px-1.5 py-1">
        {renaming ? (
          <input
            autoFocus
            defaultValue={a.name}
            className="field min-w-0 flex-1 py-0.5 text-xs"
            onBlur={(e) => onRename(e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") onCancelRename();
            }}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs"
            title={a.name}
            onDoubleClick={onStartRename}
          >
            {a.name}
          </span>
        )}
        <button
          aria-label="Favorite"
          onClick={onFavorite}
          className={`shrink-0 text-xs ${a.favorited ? "text-accent" : "text-muted hover:text-text"}`}
        >
          {a.favorited ? "★" : "☆"}
        </button>
        <button
          aria-label="Delete"
          onClick={onDelete}
          className="shrink-0 text-xs text-muted hover:text-danger"
        >
          ✕
        </button>
      </div>

      <div className="flex items-center justify-between px-1.5 pb-1">
        <button
          onClick={onSwapKind}
          title="Switch category"
          className="rounded bg-surface-raised px-1 text-[10px] uppercase text-muted hover:text-text"
        >
          {a.kind.toLowerCase()}
        </button>
        <span className="text-[10px] text-muted">
          {a.width ? `${a.width}×${a.height}` : ""}
          {a.durationMs ? ` ${fmtDur(a.durationMs)}` : ""}
          {a.sizeBytes ? ` · ${fmtSize(a.sizeBytes)}` : ""}
        </span>
      </div>
    </div>
  );
}
