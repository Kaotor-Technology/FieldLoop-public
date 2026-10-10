import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import type { EnvelopeKeyService } from "@fieldloop/adapters";
import type { EnvelopeCrypto } from "./model.js";

const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_KEYS = 200;

interface CachedKey {
  dataKey: Buffer;
  expiresAt: number;
}

export class KmsEnvelopeCrypto implements EnvelopeCrypto {
  private readonly dataKeys = new Map<string, CachedKey>();

  constructor(private readonly keys: EnvelopeKeyService) {}

  async encryptNew(value: string, additionalData = ""): Promise<{ ciphertext: Buffer; wrappedDataKey: Buffer }> {
    const dataKey = randomBytes(DATA_KEY_BYTES);
    const wrappedDataKey = await this.keys.wrapKey(dataKey);
    this.cacheKey(wrappedDataKey, dataKey);
    return { ciphertext: this.encrypt(value, dataKey, additionalData), wrappedDataKey };
  }

  async encryptWithKey(value: string, wrappedDataKey: Buffer, additionalData = ""): Promise<Buffer> {
    return this.encrypt(value, await this.unwrap(wrappedDataKey), additionalData);
  }

  async decryptWithKey(ciphertext: Buffer, wrappedDataKey: Buffer, additionalData = ""): Promise<string> {
    return this.decrypt(ciphertext, await this.unwrap(wrappedDataKey), additionalData);
  }

  private async unwrap(wrappedDataKey: Buffer): Promise<Buffer> {
    const cacheKey = this.cacheId(wrappedDataKey);
    const cached = this.dataKeys.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.dataKey;
    if (cached) this.dataKeys.delete(cacheKey);

    const dataKey = await this.keys.unwrapKey(wrappedDataKey);
    if (dataKey.byteLength !== DATA_KEY_BYTES) throw new Error("KMS returned an invalid session key");
    this.cacheKey(wrappedDataKey, dataKey);
    return dataKey;
  }

  private encrypt(value: string, dataKey: Buffer, additionalData: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
    cipher.setAAD(Buffer.from(additionalData, "utf8"));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }

  private decrypt(value: Buffer, dataKey: Buffer, additionalData: string): string {
    if (value.byteLength < NONCE_BYTES + TAG_BYTES) throw new Error("Encrypted session value is truncated");
    const nonce = value.subarray(0, NONCE_BYTES);
    const tag = value.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const encrypted = value.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce);
    decipher.setAAD(Buffer.from(additionalData, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  private cacheKey(wrappedDataKey: Buffer, dataKey: Buffer): void {
    const id = this.cacheId(wrappedDataKey);
    this.dataKeys.delete(id);
    this.dataKeys.set(id, { dataKey, expiresAt: Date.now() + CACHE_TTL_MS });
    while (this.dataKeys.size > MAX_CACHED_KEYS) {
      const oldest = this.dataKeys.keys().next().value;
      if (oldest === undefined) break;
      this.dataKeys.delete(oldest);
    }
  }

  private cacheId(wrappedDataKey: Buffer): string {
    return createHash("sha256").update(wrappedDataKey).digest("hex");
  }
}
