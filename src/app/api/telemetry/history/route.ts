import { route } from "@/lib/api/http.ts";
import { db } from "@/lib/db.ts";
import { requireUserId } from "@/lib/auth/session.ts";
import { parseHistoryQuery, readHistory } from "@/lib/telemetry/read.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/telemetry/history?since=&limit= — a window of recorded activity.
 *
 * What the /brain page's REPLAY mode reads. Defaults to the last four hours and
 * is capped at 2000 rows; both bounds are enforced in `parseHistoryQuery` so
 * the ceiling cannot be argued up from the query string.
 *
 * Telemetry is machine-wide rather than per-user, so this only checks that
 * *somebody* is signed in — in the desktop build that is automatic, and on a
 * hosted deployment it keeps the event log off the public internet.
 */
export const GET = route(async (req: Request) => {
  await requireUserId();
  const query = parseHistoryQuery(new URL(req.url).searchParams);
  const events = await readHistory(db, query);
  return Response.json({ events, since: query.since.toISOString() });
});
