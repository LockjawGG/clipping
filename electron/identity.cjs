/**
 * The CommonJS mirror of `src/lib/app-identity.ts`.
 *
 * The Electron main process titles the window before any page has loaded and
 * cannot import the TypeScript module the rest of the app reads, so the same
 * three strings live here too. `tests/beta-safety.test.ts` asserts this file,
 * `src/lib/app-identity.ts` and `package.json` all agree, so the duplication
 * cannot quietly rot.
 */
const APP_IDENTITY = {
  name: "Clipper",
  channel: "beta",
  version: "1.2.0-beta.1",
  label: "Clipper 1.02 beta",
  isBeta: true,
  docSchemaVersion: 1,
};

module.exports = { APP_IDENTITY };
