import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { StorageProvider } from "../providers/types.ts";
import { assertSafeKey } from "./keys.ts";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for R2 / MinIO. Omit for AWS. */
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  defaultExpiresInSec?: number;
}

/** S3-compatible object storage: AWS S3, Cloudflare R2, MinIO. */
export class S3StorageProvider implements StorageProvider {
  readonly name = "s3";

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly defaultExpiresInSec: number;

  constructor(opts: S3StorageOptions) {
    const config: S3ClientConfig = {
      region: opts.region,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    };
    if (opts.endpoint) config.endpoint = opts.endpoint;
    if (opts.forcePathStyle) config.forcePathStyle = true;

    this.client = new S3Client(config);
    this.bucket = opts.bucket;
    this.defaultExpiresInSec = opts.defaultExpiresInSec ?? 900;
  }

  async createUploadUrl(key: string, contentType: string, expiresInSec = this.defaultExpiresInSec): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSec },
    );
  }

  async createDownloadUrl(key: string, expiresInSec = this.defaultExpiresInSec): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSec,
    });
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<void> {
    assertSafeKey(key);
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentType: contentType,
      },
    });
    await upload.done();
  }

  async getToFile(key: string, localPath: string): Promise<void> {
    assertSafeKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`empty response body for ${key}`);
    await mkdir(dirname(resolve(localPath)), { recursive: true });
    await pipeline(res.Body as Readable, createWriteStream(localPath));
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }
}
