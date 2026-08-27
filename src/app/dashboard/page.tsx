import { redirect } from "next/navigation";

import { db } from "@/lib/db.ts";
import { currentUserId } from "@/lib/auth/session.ts";
import { SignOutButton } from "./sign-out-button";
import { UploadButton } from "./upload-button";

export const metadata = { title: "Dashboard · Clipper" };
export const dynamic = "force-dynamic";

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "READY"
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
      : status === "FAILED"
        ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
        : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{status}</span>;
}

export default async function DashboardPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/login");

  const videos = await db.video.findMany({
    where: { project: { userId } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      originalFilename: true,
      status: true,
      durationMs: true,
      createdAt: true,
      _count: { select: { clips: true } },
    },
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Your videos</h1>
        <div className="flex items-center gap-4">
          <UploadButton />
          <SignOutButton />
        </div>
      </header>

      {videos.length === 0 ? (
        <p className="text-neutral-500">Nothing yet. Upload a video to get started.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {videos.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{v.originalFilename}</p>
                <p className="text-sm text-neutral-500">
                  {v.durationMs ? `${Math.round(v.durationMs / 1000)}s · ` : ""}
                  {v._count.clips} clip{v._count.clips === 1 ? "" : "s"} ·{" "}
                  {v.createdAt.toISOString().slice(0, 10)}
                </p>
              </div>
              <StatusPill status={v.status} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
