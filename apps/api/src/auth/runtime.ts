import { GoogleCloudKmsEnvelopeKeyService, GoogleCloudSecretReader } from "@fieldloop/adapters";
import { AuthError, BffAuthService, type AuthServicePort } from "./service.js";
import { KmsEnvelopeCrypto } from "./envelope-crypto.js";
import { SecretManagerInternalTokenService } from "./internal-tokens.js";
import { KeycloakOidcProvider } from "./keycloak-oidc.js";
import { createAuthDatabase, createCloudSqlAuthDatabase, PostgresAuthStore } from "./postgres-store.js";
import { PostgresMapLayerStore, UnavailableMapLayerStore, type MapLayerStore } from "../map/layers.js";

export class UnavailableAuthService implements AuthServicePort {
  async startLogin(): Promise<URL> { return this.unavailable(); }
  async startReauthentication(): Promise<URL> { return this.unavailable(); }
  async completeLogin(): Promise<never> { return this.unavailable(); }
  async getCurrentUser(): Promise<never> { return this.unavailable(); }
  async issueInternalUserToken(): Promise<never> { return this.unavailable(); }
  async logout(): Promise<URL> { return this.unavailable(); }
  async backchannelLogout(): Promise<never> { return this.unavailable(); }
  async jwks(): Promise<never> { return this.unavailable(); }

  private unavailable(): never {
    throw new AuthError("BFF authentication is not configured", 503);
  }
}

export async function createProductionAuthRuntime(): Promise<{
  auth: AuthServicePort;
  mapLayers: MapLayerStore;
  close: () => Promise<void>;
}> {
  const baseUrl = process.env["FIELDLOOP_BASE_URL"];
  const defaultOrgId = process.env["FIELDLOOP_DEFAULT_ORG_ID"];
  const kmsKeyName = process.env["FIELDLOOP_SESSION_KMS_KEY"];
  const projectId = process.env["GOOGLE_CLOUD_PROJECT"];
  const cloudSqlConnection = process.env["FIELDLOOP_DB_CONNECTION_NAME"];
  const cloudSqlDatabase = process.env["FIELDLOOP_DB_NAME"];
  const cloudSqlUser = process.env["FIELDLOOP_DB_USER"];
  const databaseUrl = process.env["DATABASE_URL"];
  const cloudSqlConfig =
    cloudSqlConnection && cloudSqlDatabase && cloudSqlUser
      ? { instanceConnectionName: cloudSqlConnection, database: cloudSqlDatabase, user: cloudSqlUser }
      : undefined;

  if (!baseUrl || !defaultOrgId || !kmsKeyName || !projectId || (!databaseUrl && !cloudSqlConfig)) {
    return { auth: new UnavailableAuthService(), mapLayers: new UnavailableMapLayerStore(), close: async () => {} };
  }

  const database = databaseUrl
    ? createAuthDatabase(databaseUrl)
    : cloudSqlConfig
      ? await createCloudSqlAuthDatabase(cloudSqlConfig)
      : undefined;
  if (!database) return { auth: new UnavailableAuthService(), mapLayers: new UnavailableMapLayerStore(), close: async () => {} };
  const secrets = new GoogleCloudSecretReader(projectId);
  const oidc = new KeycloakOidcProvider(
    process.env["KEYCLOAK_ISSUER"] ?? "https://auth.example.com/realms/example-realm",
    process.env["KEYCLOAK_CLIENT_ID"] ?? "kaotor-fieldloop",
    () => secrets.read("fieldloop-v2-keycloak-client"),
  );
  const auth = new BffAuthService({
    store: new PostgresAuthStore(database.db),
    crypto: new KmsEnvelopeCrypto(new GoogleCloudKmsEnvelopeKeyService(kmsKeyName)),
    oidc,
    internalTokens: new SecretManagerInternalTokenService(
      secrets,
      new URL(baseUrl).origin,
      "fieldloop-services",
      process.env["FIELDLOOP_INTERNAL_SIGNING_KID"] ?? "current",
    ),
    baseUrl,
    defaultOrgId,
    clientId: process.env["KEYCLOAK_CLIENT_ID"] ?? "kaotor-fieldloop",
  });

  return {
    auth,
    mapLayers: new PostgresMapLayerStore(database.db),
    close: async () => {
      if ("close" in database && typeof database.close === "function") await database.close();
      else await database.db.destroy();
    },
  };
}
