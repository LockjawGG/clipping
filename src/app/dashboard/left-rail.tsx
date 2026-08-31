"use client";

import { useState } from "react";

import { SignOutButton } from "./sign-out-button";
import { ProjectRail, type ProjectSummary, type FavoriteClip } from "./project-rail";
import { MediaLibrary, type AssetView } from "./media-library";
import { TrainingRail } from "./training-rail";

/** Left column: a Projects / Media / Training tab switch above the panels. */
export function LeftRail({
  projects,
  activeProjectId,
  favorites,
  assets,
  showSignOut = true,
}: {
  projects: ProjectSummary[];
  activeProjectId: string;
  favorites: FavoriteClip[];
  assets: AssetView[];
  /** Desktop runs as a single local user, where signing out means nothing. */
  showSignOut?: boolean;
}) {
  const [tab, setTab] = useState<"projects" | "media" | "training">("projects");

  return (
    <div className="rail flex h-full min-h-0 flex-col px-0">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-sm font-semibold">Clipper</span>
        {showSignOut && <SignOutButton />}
      </div>

      <div role="tablist" className="tabs mx-3 mb-1 self-start">
        <button role="tab" aria-selected={tab === "projects"} className="tab" onClick={() => setTab("projects")}>
          Projects
        </button>
        <button role="tab" aria-selected={tab === "media"} className="tab" onClick={() => setTab("media")}>
          Media
        </button>
        <button
          role="tab"
          aria-selected={tab === "training"}
          className="tab"
          onClick={() => setTab("training")}
          title="What the editor has learned from your finished edits"
        >
          Training
        </button>
      </div>

      {tab === "projects" && (
        <ProjectRail projects={projects} activeProjectId={activeProjectId} favorites={favorites} />
      )}
      {tab === "media" && <MediaLibrary assets={assets} />}
      {tab === "training" && <TrainingRail />}
    </div>
  );
}
