import { readFile } from "node:fs/promises";

import { readJson, route } from "@/lib/api/http.ts";
import { db } from "@/lib/db.ts";
import { env } from "@/lib/env.ts";
import { emitTelemetry } from "@/lib/telemetry/emit.ts";
import { authorizeIngest, parseIngestBody } from "@/lib/telemetry/ingest.ts";
import type { TelemetryDb } from "@/lib/telemetry/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read the shared secret, or null when ingest is not configured / unreadable. */
async function expectedKey(): Promise<string | null> {
  const path = env.TELEMETRY_KEY_FILE;
  if (!path) return null;
  try {
    const contents = (await readFile(path, "utf8")).trim();
    return contents.length > 0 ? contents : null;
  } catch {
    // A configured-but-missing key file is the same answer as unconfigured:
    // closed. The 501 body says how to fix it.
    return null;
  }
}

/**
 * POST /api/telemetry/ingest — relay events about actors this process cannot see.
 *
 * The app instruments what it runs itself. Agents inside a Claude session are
 * outside it, so whatever is driving that session posts here and their work
 * appears on /brain next to the local model and the job queue. Everything that
 * arrives is a claim from another program, which is why the door is narrow:
 *
 *   - loopback requests only — this is a desktop app talking to itself;
 *   - a shared secret in `x-telemetry-key`, read from TELEMETRY_KEY_FILE;
 *   - a strict whitelist, so a relay cannot invent columns or oversized rows.
 *
 * With TELEMETRY_KEY_FILE unset the route is off and answers 501. It never
 * synthesises an event of its own — an empty page means nothing was relayed.
 *
 * Accepts one event or an array (max 100). No session is required: the caller
 * is a program on this machine holding the key, not a signed-in person.
 */
export const POST = route(async (req: Request) => {
  const auth = authorizeIngest({
    url: req.url,
    providedKey: req.headers.get("x-telemetry-key"),
    expectedKey: await expectedKey(),
  });
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const events = parseIngestBody(await readJson(req));
  // Awaited, unlike the in-process emitters: the relay is entitled to know how
  // much of its batch actually landed, and this is not on a user-facing path.
  const results = await Promise.all(
    events.map((event) => emitTelemetry(db as unknown as TelemetryDb, event)),
  );
  const stored = results.filter(Boolean).length;

  return Response.json({ accepted: events.length, stored }, { status: 202 });
});
