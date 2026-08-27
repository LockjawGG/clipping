import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import type { StorageProvider } from "../providers/types.ts";
import { assertSafeKey } from "./keys.ts";
import { signStorageToken } from "./signing.ts";

export interface LocalStorageOptions {
  /** Directory the keys are rooted at. Created on demand. */
  baseDir: string;
  /** Origin the signed upload/download URLs are built against. */
  publicBaseUrl: string;
  /** HMAC secret for the signed URLs. */
  secret: string;
  /** Default lifetime for signed URLs, in seconds. */
  defaultExpiresInSec?: number;
}

/**
 * Filesystem-backed storage for local development. Bytes live under `baseDir`;
 * signed URLs point at `/api/storage/local/<key>` (route added in a later PR),
 * which re-checks the token before reading or writing.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local";

  private readonly baseDir: string;
  private readonly publicBaseUrl: string;
  private readonly secret: string;
  private readonly defaultExpiresInSec: number;

  constructor(opts: LocalStorageOptions) {
    this.baseDir = resolve(opts.baseDir);
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/+$/, "");
    this.secret = opts.secret;
    this.defaultExpiresInSec = opts.defaultExpiresInSec ?? 900;
  }

  /** Absolute path for a key, guaranteed to stay under `baseDir`. */
  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(this.baseDir, key);
    if (full !== this.baseDir && !full.startsWith(this.baseDir + sep)) {
      throw new Error(`resolved path escapes the storage root: ${key}`);
    }
    return full;
  }

  private url(key: string, action: "put" | "get", expiresInSec: number): string {
    assertSafeKey(key);
    const token = signStorageToken({ secret: this.secret, action, key, expiresInSec });
    const path = key.split("/").map(encodeURIComponent).join("/");
    return `${this.publicBaseUrl}/api/storage/local/${path}?action=${action}&token=${token}`;
  }

  async createUploadUrl(key: string, _contentType: string, expiresInSec = this.defaultExpiresInSec): Promise<string> {
    return this.url(key, "put", expiresInSec);
  }

  async createDownloadUrl(key: string, expiresInSec = this.defaultExpiresInSec): Promise<string> {
    return this.url(key, "get", expiresInSec);
  }

  async putFile(key: string, localPath: string, _contentType: string): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(localPath, dest);
  }

  async getToFile(key: string, localPath: string): Promise<void> {
    const src = this.pathFor(key);
    await mkdir(dirname(resolve(localPath)), { recursive: true });
    // Stream rather than copyFile so this path behaves the same as the S3 one.
    await pipeline(createReadStream(src), createWriteStream(localPath));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const s = await stat(this.pathFor(key));
      return s.isFile();
    } catch {
      return false;
    }
  }

  /** Absolute path for a key. Used by the API route that serves local files. */
  resolveKey(key: string): string {
    return this.pathFor(key);
  }
}
