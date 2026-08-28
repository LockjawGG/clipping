import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db.ts";
import { currentUserId } from "@/lib/auth/session.ts";

export const dynamic = "force-dynamic";

/**
 * Legacy per-video route. The editor now lives in the one-page workspace, so
 * this just forwards to `/dashboard?project=…&video=…`.
 */
export default async function VideoPage({ params }: { params: Promise<{ videoId: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const { videoId } = await params;

  const video = await db.video.findUnique({
    where: { id: videoId },
    select: { id: true, project: { select: { id: true, userId: true } } },
  });
  if (!video || video.project.userId !== userId) notFound();

  redirect(`/dashboard?project=${video.project.id}&video=${video.id}`);
}
