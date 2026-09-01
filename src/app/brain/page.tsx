import { redirect } from "next/navigation";

import { currentUserId } from "@/lib/auth/session.ts";

import { BrainClient } from "./brain-client";

export const metadata = { title: "Jarvis" };
export const dynamic = "force-dynamic";

/**
 * /brain — what the app's AI is actually doing, as it does it.
 *
 * Everything on this page is read from recorded telemetry: the local model's
 * own token counts, the job queue's own timings, and whatever an orchestrator
 * relayed about agents this process cannot see. Nothing is simulated, and any
 * figure that was never measured is labelled "not instrumented" rather than
 * shown as a zero. A dashboard about AI activity that invents AI activity would
 * be worse than no dashboard at all.
 *
 * `?monitor=1` strips it to graph, counter, feed and stats — the form it takes
 * when it is left open on a second screen.
 */
export default async function BrainPage({
  searchParams,
}: {
  searchParams: Promise<{ monitor?: string }>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const { monitor } = await searchParams;

  return <BrainClient monitor={monitor === "1"} />;
}
