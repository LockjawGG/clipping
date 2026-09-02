# Beta isolation

This checkout (`C:\Users\Gf788\clipper-1.02-beta`, branch `beta/1.02`) is a full
copy of the production Clipper repo at `C:\Users\Gf788\clipping`. It exists so
the 1.02 editing engine can be built and tested against real footage without
risking the library the production app owns.

A copy of a repo is not isolation on its own. Both copies read the same kind of
`.env`, both default to the same database name, both want port 3000, and — once
packaged — Electron derives its data directory from the app name, which is one
string away from production's. Every one of those defaults, left alone, points
the beta at production's data, and the failure mode is silent: the beta would
appear to work while writing into a library that has no backup of the state it
overwrote.

So isolation here is not a convention. It is a set of explicit values, plus a
guard that refuses to start when any of them is wrong.

## What is isolated, and how

| Surface | Production | Beta | Enforced by |
| --- | --- | --- | --- |
| PostgreSQL database | `clipper` | `clipper_beta` | `.env` in this checkout; `assertBetaIsolation` rejects any other database name |
| Media storage | `.storage` inside `C:\Users\Gf788\clipping` | `C:/Users/Gf788/clipper-1.02-beta/.storage` | `LOCAL_STORAGE_DIR`; guard checks the resolved path is inside a beta root |
| Scratch / temp | production `TEMP_DIR` | `.tmp/clipper` inside this checkout | `TEMP_DIR`; same path check |
| Dev server port | 3000 | 3100 | `npm run dev` / `dev:beta` are pinned to `-p 3100`; guard rejects port 3000 in non-packaged mode |
| `NEXTAUTH_URL` | `http://localhost:3000` | `http://localhost:3100` | same port rule, applied to the URL's port |
| Channel marker | unset | `CLIPPER_BETA=1` | set in this checkout's `.env`, injected again by the Electron shell |
| Packaged app data | `%APPDATA%\clipping` | `%APPDATA%\clipper-102-beta` | `app.setName("clipper-102-beta")` plus an explicit `app.setPath("userData", …)`, then a startup assertion on the directory's basename |
| Installer / app identity | `com.clipper.desktop`, "Clipper" | `com.clipper.desktop.beta`, "Clipper 1.02 beta" | `electron-builder.yml`; a different appId is what lets the beta install beside production rather than on top of it |
| Package identity | name `clipping` | name `clipper-102-beta`, version `1.2.0-beta.1` | `package.json`, mirrored in `src/lib/app-identity.ts` and `electron/identity.cjs` |
| Build output | `dist-desktop` in the production checkout | `dist-desktop` in this checkout | `directories.output` in `electron-builder.yml` |
| Database backup | dumps `clipper` | dumps `clipper_beta` | `scripts\backup-db.ps1` reads `DATABASE_URL` from this checkout's `.env` |

The `CLIPPER_BETA=1` marker is what switches the guard on. Production never sets
it, so the guard is inert there and this file's rules cost production nothing.

The beta is visibly the beta, too: the left rail and the mobile top bar show a
"1.02 beta" pill next to the Clipper wordmark, and the window and page titles
read "Clipper 1.02 beta". That is not decoration — a tester filing a bug needs
to be certain which build produced it.

## The runtime guard

The rules live in `src/lib/beta-guard.ts` (TypeScript, for the Next server and
the worker) and `electron/beta-guard.cjs` (CommonJS, for the Electron main
process, which runs before anything can load TypeScript). Both export
`assertBetaIsolation({ env, allowedRoots, forbiddenRoots })`. The duplication is
deliberate — there is no build step that could produce one from the other — and
it is held together by tests running the same vectors through both modules
rather than by anyone remembering to keep them in step.

When `CLIPPER_BETA === "1"`, the assertion throws a named `BetaIsolationError`
if any of the following is true:

1. **Wrong database.** The database name in `DATABASE_URL` is not `clipper_beta`.
   Waived when `CLIPPER_EMBEDDED_PG=1`, because the packaged beta starts its own
   PostgreSQL cluster inside its own userData directory — that cluster is
   isolated by its `pgdata` path, not by the database name.
2. **Storage or temp outside the beta.** `LOCAL_STORAGE_DIR` or `TEMP_DIR`
   resolves outside every allowed root (this checkout, plus the beta userData
   directory when packaged), or inside a forbidden root (a sibling directory
   named `clipping`, or `%APPDATA%\clipping`). Relative paths are resolved
   against the working directory before the comparison, so `../clipping/.storage`
   is caught the same as an absolute path.
3. **Production port.** In non-packaged mode, `PORT` or the port in
   `NEXTAUTH_URL` is 3000. Packaged runs are exempt: the shell picks a free
   ephemeral port for its own server, so 3000 there means nothing.

It is called from three places, each of which is a point where the app is about
to touch state:

| Call site | When |
| --- | --- |
| `src/lib/env.ts` | immediately after the config is parsed. Skipped under `SKIP_ENV_VALIDATION=1`, which `next build` sets, since a build connects to nothing — and skipped in the Edge runtime (`NEXT_RUNTIME=edge`), which the auth middleware runs in: `process.cwd()` is a hard error there so the roots cannot be derived, and Edge code can neither open the database nor write a file. Every runtime that *can* do damage still checks. |
| `scripts/worker.ts` | at worker startup, before it polls for a job |
| `electron/main.cjs` | before the server, the worker or the database are started, while there is still a window in which to show the failure |

The Electron shell adds two checks of its own. It asserts that the basename of
its `userData` directory is exactly `clipper-102-beta` and quits with an error
dialog if it is not — `app.setPath` is the mechanism, this is the proof that the
mechanism worked. And it takes `app.requestSingleInstanceLock()`: a second
launch focuses the existing window instead of starting a second server, worker
and PostgreSQL cluster against one `pgdata`, which is how a database gets
corrupted.

## Packaged data layout

Everything the packaged beta writes lands under one directory,
`%APPDATA%\clipper-102-beta`:

| Entry | What it holds |
| --- | --- |
| `pgdata` | the embedded PostgreSQL cluster |
| `storage` | media: sources, thumbnails, renders |
| `tmp` | per-job scratch and the source cache |
| `remotion-browser` | the browser Remotion downloads for animated-caption renders (~270 MB) |
| `auth-secret` | generated once on first run, reused thereafter |
| `startup.log` | what the shell did before a window existed — the first thing to attach to a bug report |

Production's equivalent is `%APPDATA%\clipping`. Nothing in the beta may read,
write, move or delete anything under it.

One path had to be changed to make that true. `src/lib/pipeline/remotion.ts`
junctioned Remotion's browser cache to a literal `%APPDATA%\clipping\remotion-browser`,
so a beta render would have written ~270 MB straight into production's data
directory. It now uses `CLIPPER_USER_DATA` when the packaged shell supplies it,
falls back to `%APPDATA%\clipper-102-beta` in a beta checkout, and still resolves
to `%APPDATA%\clipping` for production, whose behaviour is unchanged. The cost is
that the beta downloads its own copy of the browser once, on its first animated
caption render.

`scripts\backup-db.ps1` needed the same treatment. It named every dump
`clipper-<stamp>.dump` and pruned by that prefix, so running it from the beta
would have deleted production's backups. Dumps are now named after the database
they came from and pruned by that name.

## Running the beta

From this checkout, in two terminals:

```bash
npm run dev:beta      # next dev --turbopack -p 3100
npm run worker:beta   # the ingest / render job worker
```

Then open <http://localhost:3100>. `npm run dev` in this checkout is pinned to
3100 as well, so there is no way to start it on production's port by habit.

Checks before anything lands:

```bash
npm test          # node --experimental-strip-types --test "tests/*.test.ts"
npm run typecheck # tsc --noEmit (expects a prior build or dev run)
```

## Packaging (later phases)

```bash
npm run desktop:dist
```

produces `dist-desktop\Clipper 1.02 beta-1.2.0-beta.1-x64.exe` — the
`artifactName` pattern is `${productName}-${version}-${arch}.${ext}`, so the
version is in the filename and two beta builds cannot be confused for each
other. The installer's appId (`com.clipper.desktop.beta`) is distinct from
production's, so it registers as a separate application rather than upgrading
the installed Clipper.

## Forbidden

Not "discouraged". These are the ways this workstream could destroy data that
cannot be recovered:

- Writing anything under `C:\Users\Gf788\clipping`. The beta reads from its own
  copy; there is never a reason to write to the production checkout.
- Touching `%APPDATA%\clipping` — production's packaged database, storage and
  auth secret.
- Replacing `Desktop\ClipperV1.0.exe` or
  `Desktop\Clipper 1.01 Beta Testing.exe`. Those are the builds the user falls
  back to when the beta is broken.
- Pointing the beta's `DATABASE_URL` at `clipper`, for any reason, including
  "just to check something".
- Running the beta on port 3000.
- Changing the Prisma schema or running data migrations in this phase. Schema
  work belongs to the phase that owns the document model, and a stray
  `prisma migrate dev` against the wrong `DATABASE_URL` is exactly the accident
  this document exists to prevent.
