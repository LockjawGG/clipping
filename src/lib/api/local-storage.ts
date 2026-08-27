import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { env } from "../env.ts";
import { getStorage } from "../storage/index.ts";
import { LocalStorageProvider } from "../storage/local.ts";
import { verifyStorageToken } from "../storage/signing.ts";
import { ApiError } from "./http.ts";

/**
 * Serves the `/api/storage/local/<key>` URLs the local storage backend signs.
 * Every request carries an HMAC token bound to one key + action + expiry;
 * `verifyStorageToken` is the only gate.
 */
export interface LocalRouteDeps {
  provider: LocalStorageProvider;
  secret: string;
  maxUploadBytes: number;
}

/** Assemble deps, or explain why this route is inactive. */
export function localRouteDeps(): LocalRouteDeps {
  const provider = getStorage();
  if (!(provider instanceof LocalStorageProvider)) {
    throw new ApiError(400, "local storage route is inactive (STORAGE_PROVIDER is not 'local')");
  }
  if (!env.NEXTAUTH_SECRET) {
    throw new ApiError(500, "NEXTAUTH_SECRET is required to verify local storage URLs");
  }
  return { provider, secret: env.NEXTAUTH_SECRET, maxUploadBytes: env.MAX_UPLOAD_BYTES };
}

/** Verify the token and resolve `keyParts` to an absolute on-disk path. */
export function authorizeLocalRequest(
  deps: LocalRouteDeps,
  keyParts: string[],
  action: "get" | "put",
  token: string | null,
): { key: string; path: string } {
  const key = keyParts.map((p) => decodeURIComponent(p)).join("/");
  if (!token) throw new ApiError(401, "missing token");

  const result = verifyStorageToken({ secret: deps.secret, action, key, token });
  if (!result.ok) throw new ApiError(403, `token rejected: ${result.reason}`);

  try {
    return { key, path: deps.provider.resolveKey(key) };
  } catch {
    throw new ApiError(400, "invalid storage key");
  }
}

export async function serveLocalFile(deps: LocalRouteDeps, keyParts: string[], token: string | null): Promise<Response> {
  const { path } = authorizeLocalRequest(deps, keyParts, "get", token);

  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    throw new ApiError(404, "not found");
  }

  const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: { "content-type": "application/octet-stream", "content-length": String(size) },
  });
}

export async function storeLocalFile(
  deps: LocalRouteDeps,
  keyParts: string[],
  token: string | null,
  req: Request,
): Promise<Response> {
  const { path } = authorizeLocalRequest(deps, keyParts, "put", token);

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > deps.maxUploadBytes) {
    throw new ApiError(413, `body exceeds the ${deps.maxUploadBytes}-byte limit`);
  }
  if (!req.body) throw new ApiError(400, "empty request body");

  await mkdir(dirname(path), { recursive: true });

  let written = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      if (written > deps.maxUploadBytes) {
        controller.error(new ApiError(413, `body exceeds the ${deps.maxUploadBytes}-byte limit`));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(req.body.pipeThrough(limit) as import("node:stream/web").ReadableStream<Uint8Array>),
    createWriteStream(path),
  );

  return new Response(null, { status: 204 });
}
