import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

export class GoogleCloudSecretReader {
  private readonly client: SecretManagerServiceClient;

  constructor(
    private readonly projectId: string,
    client = new SecretManagerServiceClient(),
  ) {
    this.client = client;
  }

  async read(secretId: string, version = "latest"): Promise<string> {
    const [response] = await this.client.accessSecretVersion({
      name: `projects/${this.projectId}/secrets/${secretId}/versions/${version}`,
    });
    const data = response.payload?.data;
    if (!data) throw new Error(`Secret ${secretId} has no payload`);
    const bytes = typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data);
    return bytes.toString("utf8").trim();
  }
}
