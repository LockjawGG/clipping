import Link from "next/link";
import { redirect } from "next/navigation";

import { db } from "@/lib/db.ts";
import { currentUserId } from "@/lib/auth/session.ts";
import { FromUrlForm } from "./from-url-form";
import { SignOutButton } from "./sign-out-button";
import { UploadButton } from "./upload-button";

export const metadata = { title: "Dashboard · Clipper" };
export const dynamic = "force-dynamic";

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "READY"
      ? "border-accent/40 text-accent"
      : status === "FAILED"
        ? "border-danger/40 text-danger"
        : "";
  return <span className={`pill ${tone}`}>{status.toLowerCase()}</span>;
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
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Your videos</h1>
          <SignOutButton />
        </div>
        <div className="flex flex-col items-end gap-3">
          <UploadButton />
          <FromUrlForm />
        </div>
      </header>

      {videos.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted">
          Nothing yet — upload a file or paste a link to get started.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {videos.map((v) => (
            <li key={v.id}>
              <Link
                href={`/dashboard/${v.id}`}
                className="card flex items-center justify-between gap-4 p-4 transition-colors hover:bg-surface-raised"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{v.originalFilename}</p>
                  <p className="text-sm text-muted">
                    {v.durationMs ? `${Math.round(v.durationMs / 1000)}s · ` : ""}
                    {v._count.clips} clip{v._count.clips === 1 ? "" : "s"} ·{" "}
                    {v.createdAt.toISOString().slice(0, 10)}
                  </p>
                </div>
                <StatusPill status={v.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
