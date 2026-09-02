/**
 * The CommonJS twin of `src/lib/beta-guard.ts`.
 *
 * The Electron main process is the first thing that runs and the only thing
 * that can still show the user a dialog, so it has to make the same isolation
 * check as the server and the worker — but it cannot import TypeScript, and the
 * server's copy cannot be compiled ahead of it without a build step this project
 * does not have. So the rules exist twice, deliberately, in two tiny files with
 * no dependencies.
 *
 * They are kept honest by testing rather than by discipline:
 * `tests/beta-safety.test.ts` runs the same vectors through both modules and
 * fails if either one disagrees. Change a rule in one, change it in the other.
 */

const BETA_DATABASE_NAME = "clipper_beta";
const FORBIDDEN_DEV_PORT = 3000;
const EMBEDDED_PG_MARKER = "CLIPPER_EMBEDDED_PG";

class BetaIsolationError extends Error {
  constructor(variable, value, detail) {
    super(`Beta isolation violation — ${variable}=${value}: ${detail}`);
    this.name = "BetaIsolationError";
    this.variable = variable;
    this.value = value;
  }
}

/** See the TypeScript twin: forward slashes, collapsed `.`/`..`, lower-cased. */
function normalizePath(p) {
  const slashed = String(p).replace(/\\/g, "/");
  const absolute = slashed.startsWith("/");
  const drive = /^[a-zA-Z]:/.test(slashed) ? slashed.slice(0, 2) : "";
  const body = drive ? slashed.slice(2) : slashed;

  const out = [];
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

function isAbsolutePath(p) {
  const s = String(p).replace(/\\/g, "/");
  return s.startsWith("/") || /^[a-zA-Z]:/.test(s);
}

function resolvePath(base, p) {
  return isAbsolutePath(p) ? normalizePath(p) : normalizePath(`${base}/${p}`);
}

function isInside(root, child) {
  if (!root) return false;
  if (child === root) return true;
  const withSep = root.endsWith("/") ? root : `${root}/`;
  return child.startsWith(withSep);
}

function databaseNameFromUrl(url) {
  const withoutQuery = String(url).split("?")[0] ?? "";
  const afterScheme = withoutQuery.replace(/^[a-zA-Z0-9+.-]+:\/\//, "");
  const slash = afterScheme.indexOf("/");
  if (slash < 0) return "";
  return decodeURIComponent(afterScheme.slice(slash + 1)).replace(/\/+$/, "");
}

function portFromUrl(url) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/.exec(String(url));
  if (!m) return null;
  const scheme = (m[1] ?? "").toLowerCase();
  const authority = m[2] ?? "";
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const colon = host.lastIndexOf(":");
  const bracket = host.lastIndexOf("]");
  if (colon > bracket && colon >= 0) {
    const n = Number(host.slice(colon + 1));
    return Number.isInteger(n) ? n : null;
  }
  if (scheme === "http") return 80;
  if (scheme === "https") return 443;
  return null;
}

/** Allowed: the beta checkout (+ beta userData). Forbidden: the sibling `clipping` and `%APPDATA%\clipping`. */
function betaRoots(o) {
  const checkout = normalizePath(o.checkoutRoot);
  const parent = checkout.slice(0, checkout.lastIndexOf("/"));
  const allowedRoots = [checkout];
  if (o.userData) allowedRoots.push(normalizePath(o.userData));

  const forbiddenRoots = [normalizePath(`${parent}/clipping`)];
  if (o.appData) forbiddenRoots.push(normalizePath(`${o.appData}/clipping`));
  return { allowedRoots, forbiddenRoots };
}

function checkDir(variable, raw, cwd, allowed, forbidden) {
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

function assertBetaIsolation(input) {
  const env = input.env;
  if (env.CLIPPER_BETA !== "1") return;

  const cwd = normalizePath(input.cwd ?? process.cwd());
  const allowed = (input.allowedRoots || []).map(normalizePath);
  const forbidden = (input.forbiddenRoots || []).map(normalizePath);

  const embedded = env[EMBEDDED_PG_MARKER] === "1" || env.DESKTOP_EMBEDDED_PG === "1";
  if (!embedded) {
    const name = databaseNameFromUrl(env.DATABASE_URL ?? "");
    if (name !== BETA_DATABASE_NAME) {
      throw new BetaIsolationError(
        "DATABASE_URL",
        `…/${name || "(no database)"}`,
        `the beta may only use the database "${BETA_DATABASE_NAME}", not "${name || "(none)"}".`,
      );
    }
  }

  for (const variable of ["LOCAL_STORAGE_DIR", "TEMP_DIR"]) {
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

  if (!input.packaged) {
    const port = env.PORT;
    if (port !== undefined && Number(port) === FORBIDDEN_DEV_PORT) {
      throw new BetaIsolationError(
        "PORT",
        port,
        `port ${FORBIDDEN_DEV_PORT} belongs to the production dev server; the beta uses 3100.`,
      );
    }
    // Unset counts as a violation: src/lib/env.ts defaults it to :3000.
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

module.exports = {
  BETA_DATABASE_NAME,
  FORBIDDEN_DEV_PORT,
  EMBEDDED_PG_MARKER,
  BetaIsolationError,
  assertBetaIsolation,
  betaRoots,
  normalizePath,
  resolvePath,
  isInside,
  databaseNameFromUrl,
  portFromUrl,
};
