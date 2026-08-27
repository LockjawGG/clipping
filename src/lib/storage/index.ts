import { ProviderUnavailableError, type StorageProvider } from "../providers/types.ts";
import { env } from "../env.ts";
import { LocalStorageProvider } from "./local.ts";
import { S3StorageProvider } from "./s3.ts";

export { assertSafeKey, isSafeKey, storageKey } from "./keys.ts";
export { signStorageToken, verifyStorageToken } from "./signing.ts";
export type { StorageAction } from "./signing.ts";
export { LocalStorageProvider } from "./local.ts";
export { S3StorageProvider } from "./s3.ts";

let cached: StorageProvider | undefined;

function build(): StorageProvider {
  if (env.STORAGE_PROVIDER === "s3") {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new ProviderUnavailableError(
        "storage:s3",
        "set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY",
      );
    }
    return new S3StorageProvider({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
  }

  if (!env.NEXTAUTH_SECRET) {
    throw new ProviderUnavailableError(
      "storage:local",
      "NEXTAUTH_SECRET must be set — it signs the local upload/download URLs",
    );
  }
  return new LocalStorageProvider({
    baseDir: env.LOCAL_STORAGE_DIR,
    publicBaseUrl: env.NEXTAUTH_URL,
    secret: env.NEXTAUTH_SECRET,
  });
}

/** The configured storage provider. Constructed once, on first call. */
export function getStorage(): StorageProvider {
  return (cached ??= build());
}

/** Test seam: drop the memoised provider. */
export function resetStorage(): void {
  cached = undefined;
}
