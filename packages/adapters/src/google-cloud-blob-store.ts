import { createHash } from "node:crypto";
import type { SaveOptions } from "@google-cloud/storage";
import type { BlobStore } from "./blob-store.js";

interface BlobFile {
  save(data: Buffer, options: SaveOptions): Promise<void>;
  download(): Promise<[Buffer]>;
}

interface StorageClient {
  bucket(name: string): { file(name: string): BlobFile };
}

export async function createGoogleCloudBlobStore(bucket: string): Promise<BlobStore> {
  const { Storage } = await import("@google-cloud/storage");
  return new GoogleCloudBlobStore(new Storage(), bucket);
}

/** Uses ADC; creates neither buckets nor public access grants. */
export class GoogleCloudBlobStore implements BlobStore {
  constructor(private readonly client: StorageClient, private readonly bucket: string) {
    if (!/^[a-z0-9][a-z0-9._-]+[a-z0-9]$/.test(bucket)) throw new Error("Invalid bucket name.");
  }

  async put(name: string, content: Uint8Array, contentType: string): Promise<string> {
    if (!name || name.startsWith("/") || name.split("/").some((part) => part === ".." || !part)) {
      throw new Error("Invalid immutable blob name.");
    }
    const file = this.client.bucket(this.bucket).file(name);
    try {
      await file.save(Buffer.from(content), {
        resumable: false, validation: "crc32c", contentType,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      // An existing object is safe to reuse only when its bytes match below.
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 412) throw error;
    }
    const [stored] = await file.download();
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    if (digest(stored) !== digest(content)) throw new Error("Stored blob content does not match the source.");
    return `gs://${this.bucket}/${name}`;
  }
}
