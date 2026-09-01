/**
 * The database, run by the app rather than installed on the machine.
 *
 * A packaged Clipper cannot assume PostgreSQL exists on the computer it lands
 * on, and the schema cannot move to something file-based: it uses eight
 * `String[]` columns and fourteen enum types, none of which Prisma supports on
 * SQLite. Six of those arrays are the censor word lists. So the server comes
 * with the app: its binaries ship in `resources/pgsql`, its cluster lives in
 * the app's own data directory, and it listens on loopback on a port nobody
 * else is using.
 *
 * First run does `initdb`, starts the server, creates the database and applies
 * `prisma/schema.sql` — the DDL generated from the same schema Prisma uses, so
 * there is no Prisma CLI to ship. Later runs just start it.
 *
 * Nothing here is reachable from outside the machine: `listen_addresses` is
 * 127.0.0.1, trust auth applies only to loopback, and the port is ephemeral.
 */

const { spawn, spawnSync } = require("node:child_process");
const { createServer } = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const ROLE = "clipper";
const DB = "clipper";

/** A port nobody is using, so two copies never collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Where the postgres binaries are.
 *
 * Packaged, they are the ones shipped beside the app. Running from a checkout
 * there is nothing to ship, so fall back to a local install — that is the
 * developer's own server, and using it keeps `npm run desktop` working against
 * the data they already have.
 */
function findBinDir(resourcesPath) {
  const bundled = resourcesPath && path.join(resourcesPath, "pgsql", "bin");
  if (bundled && fs.existsSync(path.join(bundled, "pg_ctl.exe"))) return bundled;

  for (const v of ["18", "17", "16"]) {
    const p = `C:\\Program Files\\PostgreSQL\\${v}\\bin`;
    if (fs.existsSync(path.join(p, "pg_ctl.exe"))) return p;
  }
  return null;
}

function run(exe, args, opts = {}) {
  const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `${path.basename(exe)} exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(-500)}`,
    );
  }
  return r.stdout ?? "";
}

class EmbeddedPostgres {
  /**
   * @param {object} o
   * @param {string} o.dataDir   cluster directory, created on first run
   * @param {string} o.appRoot   where prisma/schema.sql lives
   * @param {string} [o.resourcesPath] packaged resources dir, if packaged
   */
  constructor({ dataDir, appRoot, resourcesPath }) {
    this.dataDir = dataDir;
    this.appRoot = appRoot;
    this.binDir = findBinDir(resourcesPath);
    this.port = 0;
    this.started = false;
    this.proc = null;
    this.log = "";
    this.exitError = null;
  }

  get available() {
    return this.binDir !== null;
  }

  exe(name) {
    return path.join(this.binDir, `${name}.exe`);
  }

  /** Start the server, initialising and creating the database if needed. */
  async start() {
    if (!this.binDir) {
      throw new Error(
        "No PostgreSQL binaries found — the packaged app should ship them in resources/pgsql.",
      );
    }
    const fresh = !fs.existsSync(path.join(this.dataDir, "PG_VERSION"));
    if (fresh) this.initdb();

    this.port = await freePort();

    // `postgres.exe` directly, not `pg_ctl start`. On Windows pg_ctl does not
    // hand the server off and exit — it stays alive as the parent — so a
    // synchronous wait on it never returns even though the database is up and
    // serving. Owning the process also means quitting the app actually stops
    // it, rather than leaving a cluster running against a deleted directory.
    this.proc = spawn(
      this.exe("postgres"),
      [
        "-D", this.dataDir,
        "-p", String(this.port),
        "-c", "listen_addresses=127.0.0.1",
        // No unix sockets on Windows, and naming a directory that cannot be
        // created is a startup failure.
        "-c", "unix_socket_directories=",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.proc.stderr?.on("data", (b) => {
      this.log += b.toString();
      if (this.log.length > 8000) this.log = this.log.slice(-8000);
    });
    this.proc.on("exit", (code) => {
      this.started = false;
      if (code !== 0 && code !== null) this.exitError = `postgres exited ${code}`;
    });

    await this.waitReady();
    this.started = true;

    if (fresh) this.createDatabase();
    else this.applyUpgrades();
    return this.url();
  }

  /**
   * Poll until the server answers, rather than assuming a fixed delay.
   *
   * `pg_isready` is the server's own answer to "are you listening", so this
   * cannot race a slow first start on a cold disk.
   */
  async waitReady(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exitError) throw new Error(`${this.exitError}
${this.log.trim().slice(-400)}`);
      const r = spawnSync(this.exe("pg_isready"), ["-h", "127.0.0.1", "-p", String(this.port)], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (r.status === 0) return;
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error(
      `PostgreSQL did not become ready on port ${this.port}
${this.log.trim().slice(-400)}`,
    );
  }

  initdb() {
    fs.mkdirSync(path.dirname(this.dataDir), { recursive: true });
    // Trust auth is safe here and only here: the server listens on loopback
    // only, so "trust" means "any process already running as this user", which
    // is exactly who the app is.
    run(this.exe("initdb"), [
      "-D", this.dataDir,
      "-U", ROLE,
      "-E", "UTF8",
      "--auth=trust",
      "--auth-host=trust",
    ]);
  }

  createDatabase() {
    const psql = this.exe("psql");
    const base = ["-h", "127.0.0.1", "-p", String(this.port), "-U", ROLE, "-q"];
    run(psql, [...base, "-d", "postgres", "-c", `CREATE DATABASE ${DB};`]);

    const ddl = path.join(this.appRoot, "prisma", "schema.sql");
    if (!fs.existsSync(ddl)) {
      throw new Error(`Cannot create the database: ${ddl} is missing from the package.`);
    }
    // ON_ERROR_STOP so a half-applied schema fails loudly here rather than
    // surfacing later as a missing table in the middle of an edit.
    run(psql, [...base, "-d", DB, "-v", "ON_ERROR_STOP=1", "-f", ddl]);
  }

  /**
   * Bring an existing cluster up to the current schema.
   *
   * schema.sql only ever runs on a fresh cluster, so a data directory created
   * by an older build never sees new tables. upgrades.sql is the idempotent
   * delta — every statement in it is safe to run on every start.
   */
  applyUpgrades() {
    const file = path.join(this.appRoot, "prisma", "upgrades.sql");
    if (!fs.existsSync(file)) return;
    try {
      run(this.exe("psql"), [
        "-h", "127.0.0.1", "-p", String(this.port), "-U", ROLE, "-d", DB,
        "-v", "ON_ERROR_STOP=1", "-q", "-f", file,
      ]);
    } catch (e) {
      // Startup should not die on an upgrade the app may not even need yet;
      // the feature that wants the table will fail with a clearer message.
      console.error("settings upgrade failed:", e?.message ?? e);
    }
  }

  url() {
    return `postgresql://${ROLE}@127.0.0.1:${this.port}/${DB}`;
  }

  /** Stop the server. Safe to call when it was never started. */
  stop() {
    if (!this.started || !this.binDir) return;
    this.started = false;
    try {
      // `fast` rolls back open transactions and exits without waiting for
      // clients — ours are already gone. Ask politely first so the cluster is
      // left clean and the next start does not have to recover.
      run(this.exe("pg_ctl"), ["-D", this.dataDir, "-m", "fast", "-w", "stop"]);
    } catch {
      // If that failed the server is wedged or already gone; killing the
      // process we own is the remaining option.
      try {
        this.proc?.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { EmbeddedPostgres };
