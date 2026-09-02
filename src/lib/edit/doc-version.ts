/**
 * The version stamp on a saved edit document.
 *
 * An edit document is data a user cannot re-derive: it is the hours of trimming,
 * captioning and keyframing that a render is generated *from*. So the format has
 * to be able to change without a newer build quietly destroying a document an
 * older one wrote, or an older build quietly destroying a newer one.
 *
 * Two directions, two answers:
 *
 *   - Older than us. The document is walked forward through the `migrations`
 *     registry, one step per version, each step a pure function. Editing then
 *     proceeds normally and the next save writes the current version.
 *   - Newer than us. There is no way to understand fields that did not exist
 *     when this build shipped, and guessing loses them on the next save. The
 *     document is returned `readOnly` so it can be viewed and never rewritten.
 *
 * Nothing calls this yet — it is the seed the editor's load path will be moved
 * onto in a later phase, landed early so the format is versioned *before* the
 * beta starts writing documents. Zero imports, pure, fully testable.
 */

/** The envelope version this build writes. */
export const CURRENT_DOC_SCHEMA_VERSION = 1;

/** An edit document with its envelope field removed. */
export type DocPayload = Record<string, unknown>;

/**
 * One step forward. `from` is the version the step consumes, `to` the version it
 * produces — always `from + 1`, so the chain is walked without a search. `apply`
 * must be pure: it receives a payload and returns a new one.
 */
export type DocMigration = {
  from: number;
  to: number;
  apply: (doc: DocPayload) => DocPayload;
};

/**
 * The migration chain, oldest first. Empty at version 1: there is nothing older
 * than the first format. Appending a step here and bumping
 * CURRENT_DOC_SCHEMA_VERSION is the whole procedure for a format change.
 */
export const DOC_MIGRATIONS: readonly DocMigration[] = [];

export type DocEnvelopeResult =
  | {
      ok: true;
      /** The version the document is at after migration — always the current one unless readOnly. */
      version: number;
      doc: DocPayload;
      /** True when the document came from a newer build and must not be written back. */
      readOnly: boolean;
    }
  | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a saved document's envelope, migrating it forward when it is old.
 *
 * Rejects rather than guesses: a missing, non-integer or out-of-range
 * `schemaVersion` means the file is not one of ours (or is corrupt), and
 * treating it as version 1 would be a silent data loss the user only discovers
 * after saving over it.
 */
export function readDocEnvelope(json: unknown): DocEnvelopeResult {
  if (!isPlainObject(json)) {
    return { ok: false, reason: `expected an object envelope, received ${json === null ? "null" : Array.isArray(json) ? "an array" : typeof json}` };
  }

  const raw = json.schemaVersion;
  if (raw === undefined) {
    return { ok: false, reason: "missing schemaVersion" };
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return { ok: false, reason: `invalid schemaVersion: ${JSON.stringify(raw)}` };
  }

  // The payload is everything but the envelope field, so a migration never has
  // to think about the version it is being run for.
  const { schemaVersion: _ignored, ...rest } = json;
  const payload: DocPayload = { ...rest };

  if (raw > CURRENT_DOC_SCHEMA_VERSION) {
    return { ok: true, version: raw, doc: payload, readOnly: true };
  }

  let version = raw;
  let doc = payload;
  while (version < CURRENT_DOC_SCHEMA_VERSION) {
    const step = DOC_MIGRATIONS.find((m) => m.from === version);
    if (!step) {
      return {
        ok: false,
        reason: `no migration from schemaVersion ${version} to ${CURRENT_DOC_SCHEMA_VERSION}`,
      };
    }
    doc = step.apply(doc);
    version = step.to;
  }

  return { ok: true, version, doc, readOnly: false };
}

/** Stamp a payload with the current envelope version, ready to serialise. */
export function writeDocEnvelope(doc: DocPayload): Record<string, unknown> {
  return { schemaVersion: CURRENT_DOC_SCHEMA_VERSION, ...doc };
}
