"use client";

import { useState } from "react";

import { SignOutButton } from "./sign-out-button";
import { ProjectRail, type ProjectSummary, type FavoriteClip } from "./project-rail";
import { MediaLibrary, type AssetView } from "./media-library";

/** Left column: a Projects / Media tab switch above the two panels. */
export function LeftRail({
  projects,
  activeProjectId,
  favorites,
  assets,
}: {
  projects: ProjectSummary[];
  activeProjectId: string;
  favorites: FavoriteClip[];
  assets: AssetView[];
}) {
  const [tab, setTab] = useState<"projects" | "media">("projects");

  return (
    <div className="rail flex h-full min-h-0 flex-col px-0">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-sm font-semibold">Clipper</span>
        <SignOutButton />
      </div>

      <div role="tablist" className="tabs mx-3 mb-1 self-start">
        <button role="tab" aria-selected={tab === "projects"} className="tab" onClick={() => setTab("projects")}>
          Projects
        </button>
        <button role="tab" aria-selected={tab === "media"} className="tab" onClick={() => setTab("media")}>
          Media
        </button>
      </div>

      {tab === "projects" ? (
        <ProjectRail projects={projects} activeProjectId={activeProjectId} favorites={favorites} />
      ) : (
        <MediaLibrary assets={assets} />
      )}
    </div>
  );
}
