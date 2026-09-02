/**
 * Does a fresh cluster actually come up with the right schema?
 *
 * The packaged app creates its own database on first run: `prisma/schema.sql`
 * on a new cluster, then `prisma/upgrades.sql` on every start. Nobody runs
 * `prisma migrate` there — there is no Prisma CLI in the package. So those two
 * files *are* the schema for every user who is not the developer, and the only
 * way to know they still produce the same database the developer has been
 * editing against is to build one and compare.
 *
 * `upgrades.sql` is applied twice on purpose. Every statement in it runs on
 * every launch, so "idempotent" is not a nice property there, it is the
 * contract; a statement that is not gets caught here rather than on a tester's
 * second start.
 *
 * Environment-gated. It needs a real PostgreSQL, so it announces itself as
 * skipped rather than failing on a machine that has none. It creates and drops
 * a database of its own and never opens the production one — the name is
 * asserted before anything connects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = join(ROOT, "prisma", "schema.sql");
const UPGRADES_SQL = join(ROOT, "prisma", "upgrades.sql");

/** The only database this test is allowed to read, and the prefix it may create. */
const BETA_DB = "clipper_beta";
const TEMP_PREFIX = "clipper_beta_bootstrap_";

/**
 * `.env` without a dotenv dependency — the same shape `electron/main.cjs`
 * parses, kept deliberately dumb.
 */
function readEnvFile(): Record<string, string> {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]!;
      const close = value.indexOf(quote, 1);
      if (close > 0) value = value.slice(1, close);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[key] = value;
  }
  return out;
}

type Conn = { base: string; database: string };

/** Split a PostgreSQL URL into "everything before the database" and the database. */
function splitUrl(url: string): Conn | null {
  const withoutQuery = url.split("?")[0] ?? "";
  const slash = withoutQuery.indexOf("/", withoutQuery.indexOf("//") + 2);
  if (slash < 0) return null;
  const database = withoutQuery.slice(slash + 1).replace(/\/+$/, "");
  if (!database) return null;
  return { base: withoutQuery.slice(0, slash), database };
}

const fileEnv = readEnvFile();
const pgBinDir = process.env.PG_BIN_DIR ?? fileEnv.PG_BIN_DIR ?? "";
const databaseUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL ?? "";
const psql = pgBinDir ? join(pgBinDir, "psql.exe") : "";
const conn = databaseUrl ? splitUrl(databaseUrl) : null;

function psqlRun(url: string, args: string[]) {
  return spawnSync(psql, ["-v", "ON_ERROR_STOP=1", "-q", ...args, url], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
  });
}

/** Why this test is not running, or null when it can. */
function skipReason(): string | null {
  if (!psql || !existsSync(psql)) {
    return `PG_BIN_DIR is unset or has no psql.exe (looked for ${psql || "<unset>"}). Set PG_BIN_DIR to a PostgreSQL bin directory to run the bootstrap test.`;
  }
  if (!conn) return "No usable DATABASE_URL in the environment or .env.";
  if (conn.database !== BETA_DB) {
    return `DATABASE_URL points at "${conn.database}", not "${BETA_DB}". Refusing to run: this test only ever touches the beta database.`;
  }
  if (!existsSync(SCHEMA_SQL) || !existsSync(UPGRADES_SQL)) {
    return "prisma/schema.sql or prisma/upgrades.sql is missing.";
  }
  const probe = psqlRun(databaseUrl, ["-t", "-A", "-c", "SELECT 1"]);
  if (probe.status !== 0) {
    return `Could not reach ${BETA_DB}: ${(probe.stderr || probe.stdout || "").trim().slice(-200)}`;
  }
  return null;
}

const reason = skipReason();

/**
 * `public` tables, sorted — the thing being compared.
 *
 * `_prisma_migrations` is excluded. It is the migration CLI's own ledger, so a
 * developer's database has one and a database bootstrapped from `schema.sql`
 * never will; including it would make this test fail for the one reason that
 * says nothing about whether the app's schema matches.
 */
function tableList(url: string): string[] {
  const r = psqlRun(url, [
    "-t",
    "-A",
    "-c",
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name",
  ]);
  assert.equal(r.status, 0, `listing tables failed: ${(r.stderr || "").trim().slice(-400)}`);
  return (r.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

test("a fresh cluster bootstraps to the same schema the beta database has", { skip: reason ?? false }, () => {
  const c = conn!;
  const temp = `${TEMP_PREFIX}${randomBytes(4).toString("hex")}`;
  // Belt and braces: the drop at the end runs against a name this test built,
  // and it must be impossible for that name to be a real database.
  assert.ok(temp.startsWith(TEMP_PREFIX));
  assert.notEqual(temp, "clipper");
  assert.notEqual(temp, BETA_DB);

  const adminUrl = `${c.base}/postgres`;
  const tempUrl = `${c.base}/${temp}`;

  const created = psqlRun(adminUrl, ["-c", `CREATE DATABASE ${temp}`]);
  assert.equal(
    created.status,
    0,
    `could not create ${temp}: ${(created.stderr || "").trim().slice(-400)}`,
  );

  try {
    const schema = psqlRun(tempUrl, ["-f", SCHEMA_SQL]);
    assert.equal(
      schema.status,
      0,
      `prisma/schema.sql failed on a fresh database: ${(schema.stderr || "").trim().slice(-600)}`,
    );

    // Twice. The second run is the assertion: every statement in upgrades.sql
    // runs on every app launch, so any of them that is not idempotent is a
    // crash on somebody's second start.
    for (const pass of [1, 2]) {
      const up = psqlRun(tempUrl, ["-f", UPGRADES_SQL]);
      assert.equal(
        up.status,
        0,
        `prisma/upgrades.sql failed on pass ${pass} (it must be idempotent): ${(up.stderr || "").trim().slice(-600)}`,
      );
    }

    const bootstrapped = tableList(tempUrl);
    const existing = tableList(databaseUrl);
    assert.ok(bootstrapped.length > 0, "the bootstrapped database has no tables at all");
    assert.deepEqual(
      bootstrapped,
      existing,
      "a database built from schema.sql + upgrades.sql does not match the beta database. " +
        "Either upgrades.sql is missing a table the developer's database picked up from a " +
        "migration, or the developer's database has drifted.",
    );
  } finally {
    // Terminate first: psql's own connection is gone, but a pooled client from
    // another process would block the drop and leave the database behind.
    psqlRun(adminUrl, [
      "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${temp}'`,
    ]);
    const dropped = psqlRun(adminUrl, ["-c", `DROP DATABASE IF EXISTS ${temp}`]);
    assert.equal(
      dropped.status,
      0,
      `left ${temp} behind — drop it by hand: ${(dropped.stderr || "").trim().slice(-300)}`,
    );
  }
});

if (reason) {
  test("db-bootstrap: skipped", { skip: reason }, () => {});
}
