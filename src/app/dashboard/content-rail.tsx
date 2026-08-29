"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { UploadButton } from "./upload-button";
import { FromUrlForm } from "./from-url-form";
import { GoLive } from "./go-live";
import { RailThumb } from "./rail-thumb";
import type { ProjectSummary } from "./project-rail";

export interface VideoSummary {
  id: string;
  name: string;
  status: string;
  thumbnailUrl: string | null;
  clipCount: number;
  progress: number; // 0..1 for in-flight ingest, else 0
  jobKind: string | null; // current job's kind, e.g. "FETCH"
  startedAtMs: number | null; // when the current job was claimed
}

const STEP_LABEL: Record<string, string> = {
  FETCH: "downloading",
  PROBE: "reading media",
  EXTRACT_AUDIO: "extracting audio",
  TRANSCRIBE: "transcribing",
  ANALYZE: "finding clips",
  THUMBNAIL: "thumbnails",
  LIVE_TRANSCRIBE: "live — transcribing",
  LIVE_FINALIZE: "finalising recording",
};

/**
 * Remaining time for the current step, extrapolated from how long this much
 * progress took. Null until there is enough signal to not be a wild guess.
 */
function etaLabel(progress: number, startedAtMs: number | null, nowMs: number): string | null {
  if (!nowMs || !startedAtMs || progress < 0.05 || progress >= 1) return null;
  const elapsed = nowMs - startedAtMs;
  if (elapsed < 5_000) return null;
  const remaining = (elapsed / progress) * (1 - progress);
  if (remaining < 5_000) return "a few seconds left";
  if (remaining < 90_000) return `~${Math.round(remaining / 1000)}s left`;
  if (remaining < 90 * 60_000) return `~${Math.round(remaining / 60_000)}m left`;
  return `~${(remaining / 3_600_000).toFixed(1)}h left`;
}

const GROUPS: Array<{ key: string; label: string; match: (s: string) => boolean }> = [
  { key: "processing", label: "Processing", match: (s) => !["READY", "FAILED"].includes(s) },
  { key: "ready", label: "Ready", match: (s) => s === "READY" },
  { key: "failed", label: "Failed", match: (s) => s === "FAILED" },
];

export function ContentRail({
  videos,
  projects,
  activeProjectId,
  activeVideoId,
}: {
  videos: VideoSummary[];
  projects: ProjectSummary[];
  activeProjectId: string;
  activeVideoId: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"upload" | "link" | "live">("link");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [subMenu, setSubMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Null on the server + first paint so the ETA can't cause a hydration mismatch.
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll while anything is still ingesting so the rail (and % ) advances on its own.
  useEffect(() => {
    if (!videos.some((v) => GROUPS[0].match(v.status))) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [videos, router]);

  useEffect(() => {
    const close = () => {
      setMenuFor(null);
      setSubMenu(false);
    };
    if (menuFor) document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuFor]);

  const open = (videoId: string) =>
    router.push(`/dashboard?project=${activeProjectId}&video=${videoId}`);

  async function move(videoId: string, projectId: string) {
    setMenuFor(null);
    await fetch(`/api/videos/${videoId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    router.refresh();
  }

  async function retry(videoId: string) {
    setMenuFor(null);
    await fetch(`/api/videos/${videoId}/retry`, { method: "POST" });
    router.refresh();
  }

  /** Cancel + remove a stuck / failed video entirely (jobs, row, source file). */
  async function cancel(videoId: string) {
    setMenuFor(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/cancel`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`Couldn't remove: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
    } catch {
      alert("Couldn't remove — the server didn't respond.");
      return;
    }
    if (videoId === activeVideoId) {
      router.push(`/dashboard?project=${activeProjectId}`);
    } else {
      router.refresh();
    }
  }

  /** Delete a video outright (any status), including its clips + transcript. */
  async function remove(videoId: string, name: string) {
    setMenuFor(null);
    if (!window.confirm(`Delete “${name}”? This removes its clips and transcript too.`)) return;
    try {
      const res = await fetch(`/api/videos/${videoId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`Couldn't delete: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
    } catch {
      alert("Couldn't delete — the server didn't respond.");
      return;
    }
    if (videoId === activeVideoId) {
      router.push(`/dashboard?project=${activeProjectId}`);
    } else {
      router.refresh();
    }
  }

  async function rename(videoId: string, name: string, original: string) {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === original) return;
    await fetch(`/api/videos/${videoId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    router.refresh();
  }

  return (
    <div className="rail px-3 pb-6">
      <span className="rail-heading">Add content</span>
      <div role="tablist" className="tabs mx-2 mb-3 self-start">
        <button
          role="tab"
          aria-selected={tab === "link"}
          className="tab"
          onClick={() => setTab("link")}
        >
          From link
        </button>
        <button
          role="tab"
          aria-selected={tab === "upload"}
          className="tab"
          onClick={() => setTab("upload")}
        >
          Upload file
        </button>
        <button
          role="tab"
          aria-selected={tab === "live"}
          className="tab"
          onClick={() => setTab("live")}
        >
          Go live
        </button>
      </div>
      <div className="mx-2 mb-2">
        {tab === "link" ? (
          <FromUrlForm projectId={activeProjectId} />
        ) : tab === "upload" ? (
          <UploadButton projectId={activeProjectId} />
        ) : (
          <GoLive projectId={activeProjectId} />
        )}
      </div>

      <span className="rail-heading">Raw content</span>
      {videos.length === 0 && (
        <p className="px-2.5 text-xs text-muted">Nothing here yet — add a video above.</p>
      )}

      {GROUPS.map((g) => {
        const rows = videos.filter((v) => g.match(v.status));
        if (rows.length === 0) return null;
        return (
          <div key={g.key} className="mb-2">
            <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted">
              {g.label} · {rows.length}
            </p>
            {rows.map((v) => (
              <div key={v.id} className="relative">
                {renaming === v.id ? (
                  <div className="flex items-center gap-2 px-2.5 py-2">
                    <RailThumb url={v.thumbnailUrl} />
                    <input
                      autoFocus
                      defaultValue={v.name}
                      className="field min-w-0 flex-1 py-1"
                      onBlur={(e) => rename(v.id, e.target.value, v.name)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") rename(v.id, (e.target as HTMLInputElement).value, v.name);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  </div>
                ) : (
                <button
                  className="rail-item"
                  aria-current={v.id === activeVideoId}
                  onClick={() => open(v.id)}
                >
                  <RailThumb url={v.thumbnailUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{v.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {v.status === "READY" ? (
                        `${v.clipCount} clip${v.clipCount === 1 ? "" : "s"}`
                      ) : v.status === "FAILED" ? (
                        <>
                          <span className="text-danger">failed</span>
                          {" · "}
                          <span
                            role="button"
                            tabIndex={0}
                            className="text-accent underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              retry(v.id);
                            }}
                          >
                            retry
                          </span>
                        </>
                      ) : (
                        <>
                          {STEP_LABEL[v.jobKind ?? ""] ?? "processing"}…{" "}
                          {Math.round(v.progress * 100)}%
                          {(() => {
                            const eta = etaLabel(v.progress, v.startedAtMs, nowMs ?? 0);
                            return eta ? ` · ${eta}` : "";
                          })()}
                        </>
                      )}
                    </span>
                    {GROUPS[0].match(v.status) && (
                      <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-surface-raised">
                        <span
                          className="block h-full bg-accent transition-all"
                          style={{ width: `${Math.max(4, Math.round(v.progress * 100))}%` }}
                        />
                      </span>
                    )}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Video menu"
                    className="rounded px-1 text-muted hover:bg-elevated hover:text-text"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSubMenu(false);
                      setMenuFor(menuFor === v.id ? null : v.id);
                    }}
                  >
                    ⋯
                  </span>
                </button>
                )}
                {menuFor === v.id && (
                  <div className="menu right-2 top-12">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(null);
                        setRenaming(v.id);
                      }}
                    >
                      Rename
                    </button>
                    {v.status !== "READY" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          retry(v.id);
                        }}
                      >
                        Retry processing
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSubMenu((s) => !s);
                      }}
                    >
                      Move to project ▸
                    </button>
                    {subMenu &&
                      projects
                        .filter((p) => p.id !== activeProjectId)
                        .map((p) => (
                          <button key={p.id} onClick={() => move(v.id, p.id)}>
                            {p.name}
                          </button>
                        ))}
                    {subMenu && projects.length <= 1 && (
                      <button disabled className="text-muted">
                        no other project
                      </button>
                    )}
                    {GROUPS[0].match(v.status) && (
                      <button
                        className="text-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancel(v.id);
                        }}
                      >
                        Cancel &amp; remove
                      </button>
                    )}
                    <button
                      className="text-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(v.id, v.name);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
