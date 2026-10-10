import { describe, expect, it, vi } from "vitest";
import { KmsEnvelopeCrypto } from "../src/auth/envelope-crypto.js";

describe("KMS envelope encryption", () => {
  it("encrypts values with AES-GCM and binds ciphertext to its session field", async () => {
    const keys = {
      wrapKey: vi.fn(async (plaintext: Buffer) => Buffer.from(plaintext.toString("base64"))),
      unwrapKey: vi.fn(async (ciphertext: Buffer) => Buffer.from(ciphertext.toString("utf8"), "base64")),
    };
    const writer = new KmsEnvelopeCrypto(keys);

    const encrypted = await writer.encryptNew("access-token", "session:abc:access");
    const reader = new KmsEnvelopeCrypto(keys);

    expect(encrypted.ciphertext.toString()).not.toContain("access-token");
    await expect(reader.decryptWithKey(encrypted.ciphertext, encrypted.wrappedDataKey, "session:abc:access")).resolves.toBe("access-token");
    await expect(reader.decryptWithKey(encrypted.ciphertext, encrypted.wrappedDataKey, "session:other:access")).rejects.toThrow();
    expect(keys.wrapKey).toHaveBeenCalledOnce();
    expect(keys.unwrapKey).toHaveBeenCalledOnce();
  });
});
