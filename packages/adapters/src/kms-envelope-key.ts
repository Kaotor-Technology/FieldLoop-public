import { KeyManagementServiceClient } from "@google-cloud/kms";

export interface EnvelopeKeyService {
  wrapKey(plaintext: Buffer): Promise<Buffer>;
  unwrapKey(ciphertext: Buffer): Promise<Buffer>;
}

export class GoogleCloudKmsEnvelopeKeyService implements EnvelopeKeyService {
  constructor(
    private readonly keyName: string,
    private readonly client = new KeyManagementServiceClient(),
  ) {}

  async wrapKey(plaintext: Buffer): Promise<Buffer> {
    const [result] = await this.client.encrypt({ name: this.keyName, plaintext });
    if (!result.ciphertext) throw new Error("Cloud KMS did not return a wrapped key");
    return bytesFromGoogleApi(result.ciphertext);
  }

  async unwrapKey(ciphertext: Buffer): Promise<Buffer> {
    const [result] = await this.client.decrypt({ name: this.keyName, ciphertext });
    if (!result.plaintext) throw new Error("Cloud KMS did not return a plaintext key");
    return bytesFromGoogleApi(result.plaintext);
  }
}

function bytesFromGoogleApi(value: Uint8Array | Buffer | string): Buffer {
  return typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value);
}
