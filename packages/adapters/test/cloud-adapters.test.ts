import { AuthTypes, Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { describe, expect, it, vi } from "vitest";
import { createGoogleCloudSqlPool } from "../src/cloud-sql.js";
import { GoogleCloudKmsEnvelopeKeyService } from "../src/kms-envelope-key.js";
import { GoogleCloudSecretReader } from "../src/secret-manager.js";

describe("Google Cloud adapters", () => {
  it("wraps and unwraps envelope keys with the configured KMS key", async () => {
    const client = {
      encrypt: vi.fn(async ({ plaintext }: { plaintext?: Buffer }) => [{ ciphertext: plaintext }]),
      decrypt: vi.fn(async ({ ciphertext }: { ciphertext?: Buffer }) => [{ plaintext: ciphertext }]),
    } as unknown as KeyManagementServiceClient;
    const adapter = new GoogleCloudKmsEnvelopeKeyService("projects/test/locations/region/keyRings/test/cryptoKeys/session", client);
    const plaintext = Buffer.from("per-session-data-key");

    await expect(adapter.wrapKey(plaintext)).resolves.toEqual(plaintext);
    await expect(adapter.unwrapKey(plaintext)).resolves.toEqual(plaintext);
    expect(client.encrypt).toHaveBeenCalledWith({
      name: "projects/test/locations/region/keyRings/test/cryptoKeys/session",
      plaintext,
    });
    expect(client.decrypt).toHaveBeenCalledWith({
      name: "projects/test/locations/region/keyRings/test/cryptoKeys/session",
      ciphertext: plaintext,
    });
  });

  it("reads a named Secret Manager version and trims the payload", async () => {
    const client = {
      accessSecretVersion: vi.fn(async () => [{ payload: { data: Buffer.from("  client-secret\n") } }]),
    } as unknown as SecretManagerServiceClient;
    const reader = new GoogleCloudSecretReader("fieldloop-test", client);

    await expect(reader.read("fieldloop-v2-keycloak-client", "7")).resolves.toBe("client-secret");
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/fieldloop-test/secrets/fieldloop-v2-keycloak-client/versions/7",
    });
  });

  it("decodes byte strings returned by Google APIs as base64", async () => {
    const client = {
      encrypt: vi.fn(async () => [{ ciphertext: Buffer.from("wrapped-key").toString("base64") }]),
      decrypt: vi.fn(async () => [{ plaintext: Buffer.from("session-key").toString("base64") }]),
    } as unknown as KeyManagementServiceClient;
    const adapter = new GoogleCloudKmsEnvelopeKeyService("projects/test/locations/region/keyRings/test/cryptoKeys/session", client);

    await expect(adapter.wrapKey(Buffer.from("session-key"))).resolves.toEqual(Buffer.from("wrapped-key"));
    await expect(adapter.unwrapKey(Buffer.from("wrapped-key"))).resolves.toEqual(Buffer.from("session-key"));
  });

  it("uses the private-IP, automatic-IAM Cloud SQL connector", async () => {
    const getOptions = vi.fn(async () => ({ host: "127.0.0.1", port: 5432 }));
    const close = vi.fn();
    const connector = { getOptions, close } as unknown as Connector;
    const connection = await createGoogleCloudSqlPool(
      { instanceConnectionName: "project:region:instance", database: "fieldloop_dev", user: "web-api" },
      connector,
    );

    expect(getOptions).toHaveBeenCalledWith({
      instanceConnectionName: "project:region:instance",
      ipType: IpAddressTypes.PRIVATE,
      authType: AuthTypes.IAM,
    });
    await connection.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
