/**
 * The thing that stops the beta from eating production.
 *
 * The 1.02 beta is a full clone of the production checkout running on the same
 * machine as the real Clipper: same code, same defaults, same names. Every
 * mechanism that keeps them apart — a different database, a different storage
 * directory, a different port, a different `%APPDATA%` folder — is a *string in
 * a config file*, and a config file is exactly the thing that gets copied,
 * half-edited, or shadowed by a stray shell variable. One wrong value and the
 * beta writes into the library the user actually cares about.
 *
 * So the values are checked rather than trusted. When `CLIPPER_BETA=1` the
 * process refuses to start unless it can prove it is pointed at beta-only state.
 * Failing loudly at startup costs a confused minute; failing silently costs the
 * production database.
 *
 * Deliberately dependency-free — not even `node:path`. This module is reached
 * from `src/lib/env.ts`, which the Next server imports, and the same rules have
 * to hold in the Electron main process, which cannot import TypeScript at all.
 * `electron/beta-guard.cjs` is a line-for-line CommonJS twin of this file, and
 * `tests/beta-safety.test.ts` runs the same vectors through both so they cannot
 * drift apart. If you change a rule here, change it there.
 */

export type BetaGuardEnv = Record<string, string | undefined>;

export type BetaGuardInput = {
  env: BetaGuardEnv;
  /** Directories the beta is allowed to write inside: the checkout, and the beta userData when packaged. */
  allowedRoots: string[];
  /** Directories the beta must never write inside: the production checkout and its %APPDATA%. */
  forbiddenRoots: string[];
  /** Base for resolving relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
  /** True in the packaged Electron app, where the port rules do not apply. */
  packaged?: boolean;
};

/** The database name the beta is allowed to talk to when it is not running its own server. */
export const BETA_DATABASE_NAME = "clipper_beta";

/** The port the production dev server owns. The beta must never claim it. */
export const FORBIDDEN_DEV_PORT = 3000;

/**
 * Set by the Electron shell when the database is the app's own embedded cluster.
 *
 * The packaged beta brings its own PostgreSQL, whose data directory lives under
 * the beta `userData` — that cluster's database is called `clipper` because
 * `electron/postgres.cjs` names every cluster it creates that, and renaming it
 * would be a schema-adjacent change this phase does not make. Isolation there
 * comes from the *cluster* being beta-only, not from the database name, so the
 * name rule is waived and the path rules carry the weight instead.
 */
export const EMBEDDED_PG_MARKER = "CLIPPER_EMBEDDED_PG";

/** Thrown by {@link assertBetaIsolation}. The message always names the variable and its value. */
export class BetaIsolationError extends Error {
  readonly variable: string;
  readonly value: string;
  constructor(variable: string, value: string, detail: string) {
    super(`Beta isolation violation — ${variable}=${value}: ${detail}`);
    this.name = "BetaIsolationError";
    this.variable = variable;
    this.value = value;
  }
}

/* ------------------------------------------------------------------ paths -- */

/**
 * A comparable form of a filesystem path, without `node:path`.
 *
 * Backslashes become forward slashes, `.` and `..` are collapsed, the trailing
 * separator is dropped, and the result is lower-cased. Case folding is
 * unconditional: this is a Windows application, and folding on a case-sensitive
 * filesystem can only make the *forbidden* check stricter and the *allowed*
 * check no weaker than the OS itself would be.
 */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  const absolute = slashed.startsWith("/");
  const drive = /^[a-zA-Z]:/.test(slashed) ? slashed.slice(0, 2) : "";
  const body = drive ? slashed.slice(2) : slashed;

  const out: string[] = [];
  for (const part of body.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!drive && !absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  const prefix = drive ? `${drive}/` : absolute ? "/" : "";
  return (prefix + joined).toLowerCase();
}

function isAbsolutePath(p: string): boolean {
  const s = p.replace(/\\/g, "/");
  return s.startsWith("/") || /^[a-zA-Z]:/.test(s);
}

/** `path.resolve(base, p)` for the one case this file needs. */
export function resolvePath(base: string, p: string): string {
  return isAbsolutePath(p) ? normalizePath(p) : normalizePath(`${base}/${p}`);
}

/** True when `child` is `root` or sits underneath it. Both must already be normalized. */
export function isInside(root: string, child: string): boolean {
  if (!root) return false;
  if (child === root) return true;
  const withSep = root.endsWith("/") ? root : `${root}/`;
  return child.startsWith(withSep);
}

/* ------------------------------------------------------------------- urls -- */

/**
 * The database name out of a PostgreSQL URL, without `new URL()`.
 *
 * The last path segment, minus any query string. Returns "" when there is no
 * database in the URL at all, which the caller reports as a violation rather
 * than skipping — an unnamed database in beta mode is not something to shrug at.
 */
export function databaseNameFromUrl(url: string): string {
  const withoutQuery = url.split("?")[0] ?? "";
  const afterScheme = withoutQuery.replace(/^[a-zA-Z0-9+.-]+:\/\//, "");
  const slash = afterScheme.indexOf("/");
  if (slash < 0) return "";
  return decodeURIComponent(afterScheme.slice(slash + 1)).replace(/\/+$/, "");
}

/** The port out of an http(s) URL, defaulting the way a browser would. */
export function portFromUrl(url: string): number | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  if (!m) return null;
  const scheme = (m[1] ?? "").toLowerCase();
  const authority = m[2] ?? "";
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const colon = host.lastIndexOf(":");
  // A bare IPv6 literal has colons of its own; only a colon after `]` is a port.
  const bracket = host.lastIndexOf("]");
  if (colon > bracket && colon >= 0) {
    const n = Number(host.slice(colon + 1));
    return Number.isInteger(n) ? n : null;
  }
  if (scheme === "http") return 80;
  if (scheme === "https") return 443;
  return null;
}

/* ------------------------------------------------------------------ roots -- */

export type BetaRoots = { allowedRoots: string[]; forbiddenRoots: string[] };

/**
 * The roots every caller should use, derived rather than configured.
 *
 * Allowed: the beta checkout, plus the beta's own `userData` when packaged.
 * Forbidden: the production checkout, which is a sibling of ours named
 * `clipping`, and its roaming data directory `%APPDATA%\clipping`. Deriving them
 * means a caller cannot get the guard wrong by forgetting one.
 */
export function betaRoots(o: {
  checkoutRoot: string;
  userData?: string;
  appData?: string;
}): BetaRoots {
  const checkout = normalizePath(o.checkoutRoot);
  const parent = checkout.slice(0, checkout.lastIndexOf("/"));
  const allowedRoots = [checkout];
  if (o.userData) allowedRoots.push(normalizePath(o.userData));

  const forbiddenRoots = [normalizePath(`${parent}/clipping`)];
  if (o.appData) forbiddenRoots.push(normalizePath(`${o.appData}/clipping`));
  return { allowedRoots, forbiddenRoots };
}

/* ------------------------------------------------------------------ check -- */

function checkDir(
  variable: string,
  raw: string,
  cwd: string,
  allowed: string[],
  forbidden: string[],
): void {
  const resolved = resolvePath(cwd, raw);
  for (const bad of forbidden) {
    if (isInside(bad, resolved)) {
      throw new BetaIsolationError(
        variable,
        raw,
        `resolves to ${resolved}, which is inside the production directory ${bad}. The beta must never write there.`,
      );
    }
  }
  if (!allowed.some((root) => isInside(root, resolved))) {
    throw new BetaIsolationError(
      variable,
      raw,
      `resolves to ${resolved}, which is outside every allowed beta root (${allowed.join(", ") || "none"}).`,
    );
  }
}

/**
 * Refuse to run unless this process is pointed at beta-only state.
 *
 * A no-op unless `CLIPPER_BETA=1`, so the same call site is harmless in a
 * production checkout. Throws {@link BetaIsolationError} on the first violation
 * it finds; the message names the variable and the value, because the person
 * reading it is about to go and edit exactly that line.
 */
export function assertBetaIsolation(input: BetaGuardInput): void {
  const { env, allowedRoots, forbiddenRoots } = input;
  if (env.CLIPPER_BETA !== "1") return;

  const cwd = normalizePath(input.cwd ?? (typeof process !== "undefined" ? process.cwd() : "."));
  const allowed = allowedRoots.map(normalizePath);
  const forbidden = forbiddenRoots.map(normalizePath);

  // (a) The database. Waived only when the app is running its own cluster,
  // whose isolation is the pgdata path checked below.
  const embedded = env[EMBEDDED_PG_MARKER] === "1" || env.DESKTOP_EMBEDDED_PG === "1";
  if (!embedded) {
    const url = env.DATABASE_URL ?? "";
    const name = databaseNameFromUrl(url);
    if (name !== BETA_DATABASE_NAME) {
      throw new BetaIsolationError(
        "DATABASE_URL",
        // Never echo the connection string: it carries a password.
        `…/${name || "(no database)"}`,
        `the beta may only use the database "${BETA_DATABASE_NAME}", not "${name || "(none)"}".`,
      );
    }
  }

  // (b) Everything the app writes.
  for (const variable of ["LOCAL_STORAGE_DIR", "TEMP_DIR"] as const) {
    const raw = env[variable];
    if (raw === undefined || raw === "") {
      throw new BetaIsolationError(
        variable,
        "(unset)",
        "the beta must set it explicitly rather than inherit a default that may point at production.",
      );
    }
    checkDir(variable, raw, cwd, allowed, forbidden);
  }

  // (c) The port, in a checkout only. The packaged app picks a free port at
  // launch, so there is nothing to police there.
  if (!input.packaged) {
    const port = env.PORT;
    if (port !== undefined && Number(port) === FORBIDDEN_DEV_PORT) {
      throw new BetaIsolationError(
        "PORT",
        port,
        `port ${FORBIDDEN_DEV_PORT} belongs to the production dev server; the beta uses 3100.`,
      );
    }
    // Unset counts as a violation, not as "nothing to check": the zod schema in
    // src/lib/env.ts defaults NEXTAUTH_URL to http://localhost:3000, so leaving
    // it out is the same as writing production's port in by hand.
    const authUrl = env.NEXTAUTH_URL;
    if (authUrl === undefined || authUrl === "") {
      throw new BetaIsolationError(
        "NEXTAUTH_URL",
        "(unset)",
        `unset defaults to port ${FORBIDDEN_DEV_PORT}, which belongs to the production dev server; the beta must set it to port 3100.`,
      );
    }
    if (portFromUrl(authUrl) === FORBIDDEN_DEV_PORT) {
      throw new BetaIsolationError(
        "NEXTAUTH_URL",
        authUrl,
        `port ${FORBIDDEN_DEV_PORT} belongs to the production dev server; the beta uses 3100.`,
      );
    }
  }
}
