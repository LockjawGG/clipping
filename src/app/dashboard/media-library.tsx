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

const TABS = ["All", "Image", "GIF", "Audio", "SFX", "★"] as const;
type Tab = (typeof TABS)[number];

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

/** Measure intrinsic dimensions / duration client-side before confirming. */
function probe(file: File, kind: AssetView["kind"]): Promise<{ width?: number; height?: number; durationMs?: number }> {
  const url = URL.createObjectURL(file);
  const done = <T,>(v: T) => {
    URL.revokeObjectURL(url);
    return v;
  };
  if (kind === "AUDIO" || kind === "SFX") {
    return new Promise((res) => {
      const a = document.createElement("audio");
      a.preload = "metadata";
      a.onloadedmetadata = () => res(done({ durationMs: Math.round(a.duration * 1000) }));
      a.onerror = () => res(done({}));
      a.src = url;
    });
  }
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(done({ width: img.naturalWidth, height: img.naturalHeight }));
    img.onerror = () => res(done({}));
    img.src = url;
  });
}

export function MediaLibrary({ projectId, assets }: { projectId: string; assets: AssetView[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("All");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return assets.filter((a) => {
      if (tab === "★" && !a.favorited) return false;
      if (tab !== "All" && tab !== "★" && a.kind !== tab.toUpperCase()) return false;
      if (term && !a.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [assets, tab, q]);

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
    if (!createRes.ok) throw new Error((await createRes.json().catch(() => ({}))).error ?? "upload failed");
    const { assetId, upload } = await createRes.json();
    const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file });
    if (!put.ok) throw new Error(`upload failed (${put.status})`);
    await fetch(`/api/assets/${assetId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dims),
    });
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setBusy(files.length);
    try {
      for (const file of Array.from(files)) {
        await uploadOne(file);
        setBusy((n) => n - 1);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(0);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/assets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    router.refresh();
  }
  async function remove(id: string) {
    await fetch(`/api/assets/${id}`, { method: "DELETE" });
    router.refresh();
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
            const f = e.target.files;
            e.target.value = "";
            void onFiles(f);
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

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto pr-1">
        {shown.length === 0 && (
          <p className="col-span-2 pt-2 text-xs text-muted">
            {assets.length === 0 ? "No media yet — add images, GIFs or audio." : "Nothing matches."}
          </p>
        )}
        {shown.map((a) => (
          <div key={a.id} className="group relative overflow-hidden rounded-lg border border-border bg-surface">
            <div className="flex aspect-video items-center justify-center bg-surface-raised">
              {a.kind === "AUDIO" || a.kind === "SFX" ? (
                <span className="text-2xl text-muted">♪</span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
                <img src={a.url ?? undefined} alt="" className="h-full w-full object-contain" />
              )}
            </div>
            <div className="flex items-center gap-1 px-1.5 py-1">
              {renaming === a.id ? (
                <input
                  autoFocus
                  defaultValue={a.name}
                  className="field min-w-0 flex-1 py-0.5 text-xs"
                  onBlur={(e) => {
                    setRenaming(null);
                    if (e.target.value.trim() && e.target.value !== a.name)
                      void patch(a.id, { name: e.target.value.trim() });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : (
                <span
                  className="min-w-0 flex-1 truncate text-xs"
                  title={a.name}
                  onDoubleClick={() => setRenaming(a.id)}
                >
                  {a.name}
                </span>
              )}
              <button
                aria-label="Favorite"
                onClick={() => patch(a.id, { favorite: !a.favorited })}
                className={`shrink-0 text-xs ${a.favorited ? "text-accent" : "text-muted hover:text-text"}`}
              >
                {a.favorited ? "★" : "☆"}
              </button>
              <button
                aria-label="Delete"
                onClick={() => remove(a.id)}
                className="shrink-0 text-xs text-muted hover:text-danger"
              >
                ✕
              </button>
            </div>
            <p className="px-1.5 pb-1 text-[10px] text-muted">
              {a.kind.toLowerCase()}
              {a.width ? ` · ${a.width}×${a.height}` : ""}
              {a.durationMs ? ` · ${fmtDur(a.durationMs)}` : ""}
              {a.sizeBytes ? ` · ${fmtSize(a.sizeBytes)}` : ""}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
