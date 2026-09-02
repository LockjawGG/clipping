/**
 * Who this build says it is.
 *
 * The 1.02 beta runs beside a production Clipper on the same machine: same
 * source, same window shape, different database, different data directory. The
 * single most expensive mistake a tester can make is not knowing which one they
 * are looking at, so the identity is one exported constant that the page title,
 * the sidebar wordmark and the Electron window title all read from.
 *
 * Zero imports on purpose. This is read from a server component, from a client
 * component, and (as literal values) from the Electron main process, so it must
 * not drag Node builtins or JSON into a client bundle. `version` is duplicated
 * from package.json rather than imported for that reason; `tests/beta-safety.test.ts`
 * asserts the two never drift.
 */
export const APP_IDENTITY = {
  /** The product, unqualified. Unchanged between channels. */
  name: "Clipper",
  /** Release channel. Production builds would read "stable". */
  channel: "beta",
  /** Must equal `version` in package.json — asserted by tests. */
  version: "1.2.0-beta.1",
  /** What a human should see: window title, packaged product name, installers. */
  label: "Clipper 1.02 beta",
  isBeta: true,
  /**
   * Version of the on-disk edit-document envelope this build reads and writes.
   * Mirrors CURRENT_DOC_SCHEMA_VERSION in src/lib/edit/doc-version.ts, which is
   * the module that actually enforces it.
   */
  docSchemaVersion: 1,
} as const;

/** The short badge shown next to the wordmark, e.g. "1.02 beta". */
export const APP_CHANNEL_BADGE = "1.02 beta";

export type AppIdentity = typeof APP_IDENTITY;
