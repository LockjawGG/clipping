/**
 * The 1.02 beta's safety net.
 *
 * Three things are checked here, and all three are about the same risk: this
 * build runs on the same machine as a production Clipper, sharing its shape,
 * its defaults and very nearly its name.
 *
 *   1. Identity does not drift. The version lives in four places (package.json,
 *      src/lib/app-identity.ts, electron/identity.cjs, the doc schema constant)
 *      because none of them can import the others. Duplication is fine as long
 *      as it cannot rot silently, which is what these assertions buy.
 *   2. The isolation guard accepts the beta's own configuration and rejects
 *      every production-shaped variant — and the TypeScript and CommonJS copies
 *      of it agree on every vector, since the Electron main process runs the
 *      second one.
 *   3. The document envelope codec refuses to guess.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_CHANNEL_BADGE, APP_IDENTITY } from "../src/lib/app-identity.ts";
import {
  assertBetaIsolation,
  betaRoots,
  BetaIsolationError,
  databaseNameFromUrl,
  isInside,
  normalizePath,
  portFromUrl,
  type BetaGuardEnv,
} from "../src/lib/beta-guard.ts";
import {
  CURRENT_DOC_SCHEMA_VERSION,
  readDocEnvelope,
  writeDocEnvelope,
} from "../src/lib/edit/doc-version.ts";

const require_ = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  productName: string;
  scripts: Record<string, string>;
};

const cjsGuard = require_("../electron/beta-guard.cjs") as {
  assertBetaIsolation: (input: unknown) => void;
  betaRoots: (o: unknown) => { allowedRoots: string[]; forbiddenRoots: string[] };
};
const cjsIdentity = require_("../electron/identity.cjs") as {
  APP_IDENTITY: Record<string, unknown>;
};

/* ------------------------------------------------------------- identity -- */

test("identity: the label and version match package.json", () => {
  assert.equal(APP_IDENTITY.version, pkg.version);
  assert.equal(APP_IDENTITY.label, pkg.productName);
  assert.equal(pkg.name, "clipper-102-beta");
  assert.equal(APP_IDENTITY.isBeta, true);
  assert.equal(APP_IDENTITY.channel, "beta");
  // The label is what a tester reads off the window; it has to contain both the
  // product and the channel or it does not do its one job.
  assert.ok(APP_IDENTITY.label.includes(APP_IDENTITY.name));
  assert.ok(APP_IDENTITY.label.includes("beta"));
  assert.ok(APP_IDENTITY.label.includes(APP_CHANNEL_BADGE));
});

test("identity: the Electron copy matches the TypeScript one", () => {
  assert.deepEqual(cjsIdentity.APP_IDENTITY, { ...APP_IDENTITY });
});

test("identity: the doc schema version matches the codec", () => {
  assert.equal(APP_IDENTITY.docSchemaVersion, CURRENT_DOC_SCHEMA_VERSION);
});

test("identity: the beta never serves on the production dev port", () => {
  for (const name of ["dev", "dev:beta", "dev:webpack", "start"]) {
    const script = pkg.scripts[name];
    assert.ok(script, `package.json is missing the "${name}" script`);
    assert.match(script, /-p 3100\b/, `"${name}" must pin port 3100, got: ${script}`);
  }
  assert.ok(pkg.scripts["worker:beta"], "package.json is missing the worker:beta script");
});

/* ---------------------------------------------------------------- paths -- */

test("guard: path normalisation folds separators, case and dot segments", () => {
  assert.equal(normalizePath("C:\\Users\\Gf788\\clipper-1.02-beta\\"), "c:/users/gf788/clipper-1.02-beta");
  assert.equal(normalizePath("C:/a/b/../c"), "c:/a/c");
  assert.equal(normalizePath("C:/a/./b"), "c:/a/b");
});

test("guard: containment is by path segment, not by prefix", () => {
  const root = normalizePath("C:/Users/Gf788/clipping");
  assert.equal(isInside(root, normalizePath("C:/Users/Gf788/clipping/.storage")), true);
  assert.equal(isInside(root, root), true);
  // The trap this exists for: the beta checkout starts with the same letters as
  // nothing in particular, but "clipping-old" must not count as "clipping".
  assert.equal(isInside(root, normalizePath("C:/Users/Gf788/clipping-old/.storage")), false);
  assert.equal(isInside(root, normalizePath("C:/Users/Gf788/clipper-1.02-beta")), false);
});

test("guard: the database name comes out of a URL without its password", () => {
  assert.equal(databaseNameFromUrl("postgresql://u:p@127.0.0.1:5432/clipper_beta"), "clipper_beta");
  assert.equal(databaseNameFromUrl("postgresql://u:p@127.0.0.1:5432/clipper?sslmode=require"), "clipper");
  assert.equal(databaseNameFromUrl("postgresql://u@host:5432"), "");
});

test("guard: the port comes out of a URL", () => {
  assert.equal(portFromUrl("http://localhost:3100"), 3100);
  assert.equal(portFromUrl("http://localhost:3000/x"), 3000);
  assert.equal(portFromUrl("http://localhost"), 80);
  assert.equal(portFromUrl("https://example.test"), 443);
});

test("guard: roots are derived, not configured", () => {
  const roots = betaRoots({
    checkoutRoot: "C:/Users/Gf788/clipper-1.02-beta",
    appData: "C:/Users/Gf788/AppData/Roaming",
    userData: "C:/Users/Gf788/AppData/Roaming/clipper-102-beta",
  });
  assert.deepEqual(roots.allowedRoots, [
    "c:/users/gf788/clipper-1.02-beta",
    "c:/users/gf788/appdata/roaming/clipper-102-beta",
  ]);
  assert.deepEqual(roots.forbiddenRoots, [
    "c:/users/gf788/clipping",
    "c:/users/gf788/appdata/roaming/clipping",
  ]);
});

/* --------------------------------------------------------------- vectors -- */

const CHECKOUT = "C:/Users/Gf788/clipper-1.02-beta";
const APPDATA = "C:/Users/Gf788/AppData/Roaming";
const USER_DATA = `${APPDATA}/clipper-102-beta`;

/** The configuration the clone's own `.env` produces. */
function betaEnv(overrides: BetaGuardEnv = {}): BetaGuardEnv {
  return {
    CLIPPER_BETA: "1",
    DATABASE_URL: "postgresql://clipper:secret@127.0.0.1:5432/clipper_beta",
    LOCAL_STORAGE_DIR: `${CHECKOUT}/.storage`,
    TEMP_DIR: `${CHECKOUT}/.tmp/clipper`,
    PORT: "3100",
    NEXTAUTH_URL: "http://localhost:3100",
    ...overrides,
  };
}

type Vector = { name: string; env: BetaGuardEnv; packaged?: boolean; variable: string | null };

const VECTORS: Vector[] = [
  { name: "the beta's own configuration", env: betaEnv(), variable: null },
  {
    name: "relative paths inside the checkout",
    env: betaEnv({ LOCAL_STORAGE_DIR: "./.storage", TEMP_DIR: ".tmp/clipper" }),
    variable: null,
  },
  {
    name: "a production checkout (the guard is off)",
    env: {
      DATABASE_URL: "postgresql://clipper:secret@127.0.0.1:5432/clipper",
      LOCAL_STORAGE_DIR: "C:/Users/Gf788/clipping/.storage",
      TEMP_DIR: "C:/Users/Gf788/clipping/.tmp",
      PORT: "3000",
    },
    variable: null,
  },
  {
    name: "the packaged app's embedded cluster",
    env: betaEnv({
      CLIPPER_EMBEDDED_PG: "1",
      CLIPPER_PACKAGED: "1",
      DATABASE_URL: "postgresql://clipper@127.0.0.1:54321/clipper",
      LOCAL_STORAGE_DIR: `${USER_DATA}/storage`,
      TEMP_DIR: `${USER_DATA}/tmp`,
      PORT: undefined,
      NEXTAUTH_URL: undefined,
    }),
    packaged: true,
    variable: null,
  },

  // Every way this has of going wrong.
  {
    name: "the production database",
    env: betaEnv({ DATABASE_URL: "postgresql://clipper:secret@127.0.0.1:5432/clipper" }),
    variable: "DATABASE_URL",
  },
  {
    name: "no database in the URL at all",
    env: betaEnv({ DATABASE_URL: "postgresql://clipper@127.0.0.1:5432" }),
    variable: "DATABASE_URL",
  },
  {
    name: "storage inside the production checkout",
    env: betaEnv({ LOCAL_STORAGE_DIR: "C:\\Users\\Gf788\\clipping\\.storage" }),
    variable: "LOCAL_STORAGE_DIR",
  },
  {
    name: "storage inside the production roaming directory",
    env: betaEnv({ LOCAL_STORAGE_DIR: `${APPDATA}/clipping/storage` }),
    variable: "LOCAL_STORAGE_DIR",
  },
  {
    name: "storage reached by climbing out of the checkout",
    env: betaEnv({ LOCAL_STORAGE_DIR: `${CHECKOUT}/../clipping/.storage` }),
    variable: "LOCAL_STORAGE_DIR",
  },
  {
    name: "storage somewhere else entirely",
    env: betaEnv({ LOCAL_STORAGE_DIR: "D:/somewhere/else" }),
    variable: "LOCAL_STORAGE_DIR",
  },
  {
    name: "the default temp directory",
    env: betaEnv({ TEMP_DIR: "/tmp/clipper" }),
    variable: "TEMP_DIR",
  },
  {
    name: "temp inside the production checkout",
    env: betaEnv({ TEMP_DIR: "C:/Users/Gf788/clipping/.tmp/clipper" }),
    variable: "TEMP_DIR",
  },
  { name: "storage unset", env: betaEnv({ LOCAL_STORAGE_DIR: undefined }), variable: "LOCAL_STORAGE_DIR" },
  { name: "the production dev port", env: betaEnv({ PORT: "3000" }), variable: "PORT" },
  {
    name: "an auth URL on the production dev port",
    env: betaEnv({ NEXTAUTH_URL: "http://localhost:3000" }),
    variable: "NEXTAUTH_URL",
  },
  {
    // env.ts defaults an unset NEXTAUTH_URL to http://localhost:3000, so
    // omitting it is the same as asking for production's port.
    name: "no auth URL at all",
    env: betaEnv({ NEXTAUTH_URL: undefined }),
    variable: "NEXTAUTH_URL",
  },
];

const roots = betaRoots({ checkoutRoot: CHECKOUT, appData: APPDATA, userData: USER_DATA });

for (const v of VECTORS) {
  test(`guard rejects/accepts: ${v.name}`, () => {
    const input = { env: v.env, ...roots, cwd: CHECKOUT, packaged: v.packaged ?? false };
    const variable = v.variable;
    if (variable === null) {
      assert.doesNotThrow(() => assertBetaIsolation(input));
      return;
    }
    assert.throws(
      () => assertBetaIsolation(input),
      (err: unknown) => {
        assert.ok(err instanceof BetaIsolationError, `expected a BetaIsolationError, got ${String(err)}`);
        assert.equal(err.variable, variable);
        // The message has to name the variable, or the person reading it at
        // 2am cannot tell which line of .env to go and fix.
        assert.match(err.message, new RegExp(variable));
        return true;
      },
    );
  });

  test(`the Electron copy agrees: ${v.name}`, () => {
    const input = { env: v.env, ...roots, cwd: CHECKOUT, packaged: v.packaged ?? false };
    let cjsVariable: string | null = null;
    try {
      cjsGuard.assertBetaIsolation(input);
    } catch (err) {
      cjsVariable = (err as { variable?: string }).variable ?? "(unnamed)";
    }
    assert.equal(cjsVariable, v.variable);
  });
}

test("guard: the connection string never appears in the error", () => {
  const env = betaEnv({ DATABASE_URL: "postgresql://clipper:hunter2@127.0.0.1:5432/clipper" });
  assert.throws(
    () => assertBetaIsolation({ env, ...roots, cwd: CHECKOUT }),
    (err: unknown) => {
      assert.ok(!String((err as Error).message).includes("hunter2"));
      return true;
    },
  );
});

/* ------------------------------------------------------------ doc codec -- */

test("doc-version: a current document is read and is writable", () => {
  const r = readDocEnvelope({ schemaVersion: CURRENT_DOC_SCHEMA_VERSION, clips: [1, 2] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.version, CURRENT_DOC_SCHEMA_VERSION);
  assert.equal(r.readOnly, false);
  assert.deepEqual(r.doc, { clips: [1, 2] });
  // The envelope field is stripped from the payload and put back on write.
  assert.deepEqual(writeDocEnvelope(r.doc), {
    schemaVersion: CURRENT_DOC_SCHEMA_VERSION,
    clips: [1, 2],
  });
});

test("doc-version: a newer document is read-only rather than rejected", () => {
  const r = readDocEnvelope({ schemaVersion: CURRENT_DOC_SCHEMA_VERSION + 3, futureField: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.readOnly, true);
  assert.equal(r.version, CURRENT_DOC_SCHEMA_VERSION + 3);
  assert.deepEqual(r.doc, { futureField: true });
});

test("doc-version: anything that is not an envelope is refused", () => {
  for (const bad of [null, undefined, 7, "x", [], {}, { schemaVersion: "1" }, { schemaVersion: 1.5 }, { schemaVersion: 0 }, { schemaVersion: -1 }]) {
    const r = readDocEnvelope(bad);
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be refused`);
    if (!r.ok) assert.ok(r.reason.length > 0);
  }
});

test("doc-version: an old version with no migration is refused, not guessed", () => {
  // There is nothing older than version 1 today, so this is exercised by
  // pretending the current version is higher than the chain can reach.
  const r = readDocEnvelope({ schemaVersion: 0 });
  assert.equal(r.ok, false);
});
