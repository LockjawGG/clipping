import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { route, ApiError } from "@/lib/api/http.ts";
import { env } from "@/lib/env.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const run = promisify(execFile);

/**
 * Where pg_dump lives. The desktop shell hands the bundled binaries in
 * PG_BIN_DIR; a dev machine falls back to the local install.
 */
function pgDumpPath(): string | null {
  const candidates = [
    process.env.PG_BIN_DIR && path.join(process.env.PG_BIN_DIR, "pg_dump.exe"),
    "C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe",
    "C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe",
  ].filter(Boolean) as string[];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * POST /api/settings/backup — dump the library's database to a file.
 *
 * Media files are not included: they are plain files the user can copy, while
 * the database is the part that is invisible until it is gone. Backups land
 * beside the media store so they are found where the data is, and each carries
 * its timestamp so nothing overwrites the last good one.
 */
export const POST = route(async () => {
  await requireUserId();
  const pgDump = pgDumpPath();
  if (!pgDump) {
    throw new ApiError(501, "pg_dump was not found — database backups need the bundled PostgreSQL tools");
  }

  const dir = path.resolve(env.LOCAL_STORAGE_DIR, "..", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const file = path.join(dir, `clipper-${stamp}.dump`);

  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new ApiError(500, "no database URL configured");

  await run(pgDump, ["--no-owner", "--no-privileges", "--format=custom", `--file=${file}`, url], {
    windowsHide: true,
    timeout: 10 * 60_000,
  });

  const sizeBytes = fs.statSync(file).size;
  return Response.json({ file, sizeBytes });
});
