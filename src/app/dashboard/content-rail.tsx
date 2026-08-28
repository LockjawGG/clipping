"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { UploadButton } from "./upload-button";
import { FromUrlForm } from "./from-url-form";
import type { ProjectSummary } from "./project-rail";

export interface VideoSummary {
  id: string;
  name: string;
  status: string;
  thumbnailUrl: string | null;
  clipCount: number;
  progress: number; // 0..1 for in-flight ingest, else 0
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
  const [tab, setTab] = useState<"upload" | "link">("link");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [subMenu, setSubMenu] = useState(false);

  // Poll while anything is still ingesting so the rail advances on its own.
  useEffect(() => {
    if (!videos.some((v) => GROUPS[0].match(v.status))) return;
    const t = setInterval(() => router.refresh(), 4000);
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
      </div>
      <div className="mx-2 mb-2">
        {tab === "link" ? (
          <FromUrlForm projectId={activeProjectId} />
        ) : (
          <UploadButton projectId={activeProjectId} />
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
                <button
                  className="rail-item"
                  aria-current={v.id === activeVideoId}
                  onClick={() => open(v.id)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL */}
                  <img
                    src={v.thumbnailUrl ?? undefined}
                    alt=""
                    className="h-9 w-14 shrink-0 rounded bg-surface-raised object-cover"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{v.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {v.status === "READY"
                        ? `${v.clipCount} clip${v.clipCount === 1 ? "" : "s"}`
                        : v.status === "FAILED"
                          ? "failed"
                          : "processing…"}
                    </span>
                    {GROUPS[0].match(v.status) && (
                      <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-surface-raised">
                        <span
                          className="block h-full bg-accent transition-all"
                          style={{ width: `${Math.max(6, Math.round(v.progress * 100))}%` }}
                        />
                      </span>
                    )}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Video menu"
                    className="rounded px-1 text-muted hover:bg-surface hover:text-text"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSubMenu(false);
                      setMenuFor(menuFor === v.id ? null : v.id);
                    }}
                  >
                    ⋯
                  </span>
                </button>
                {menuFor === v.id && (
                  <div className="menu right-2 top-12">
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
