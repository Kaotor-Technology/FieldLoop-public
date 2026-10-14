import { PostgresActionStore, type ActionServicePort, GoogleCloudKmsEnvelopeKeyService, GoogleCloudSecretReader, type LoadedDomainPack } from "@fieldloop/adapters";
import { registerDomainPackRecords } from "../domain-packs.js";
import { AuthError, BffAuthService, type AuthServicePort } from "./service.js";
import { KmsEnvelopeCrypto } from "./envelope-crypto.js";
import { SecretManagerInternalTokenService } from "./internal-tokens.js";
import { KeycloakOidcProvider } from "./keycloak-oidc.js";
import { createAuthDatabase, createCloudSqlAuthDatabase, PostgresAuthStore } from "./postgres-store.js";
import { PostgresHealthStore } from "../health/postgres-store.js";
import type { HealthServicePort } from "../health/model.js";
import type { Kysely } from "kysely";
import { PostgresMapLayerStore, UnavailableMapLayerStore, type MapLayerStore } from "../map/layers.js";
import { PostgresRiskService } from "../risk/service.js";
import { createRiskDatabase } from "../risk/database.js";

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
  health?: HealthServicePort;
  actions?: ActionServicePort;
  close: () => Promise<void>;
  registerPacks?: (packs: LoadedDomainPack[]) => Promise<void>;
  risk?: PostgresRiskService;
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

  if (!databaseUrl && !cloudSqlConfig) {
    return { auth: new UnavailableAuthService(), mapLayers: new UnavailableMapLayerStore(), close: async () => {} };
  }

  const database = databaseUrl
    ? createAuthDatabase(databaseUrl)
    : cloudSqlConfig
      ? await createCloudSqlAuthDatabase(cloudSqlConfig)
      : undefined;
  if (!database) return { auth: new UnavailableAuthService(), mapLayers: new UnavailableMapLayerStore(), close: async () => {} };
  const runtime = {
    mapLayers: new PostgresMapLayerStore(database.db),
    actions: new PostgresActionStore(database.db as unknown as Kysely<Record<string, never>>),
    health: new PostgresHealthStore(database.db as unknown as Kysely<Record<string, never>>),
    risk: new PostgresRiskService(createRiskDatabase(database.pool)),
    close: async () => {
      if ("close" in database && typeof database.close === "function") await database.close();
      else await database.db.destroy();
    },
    ...(defaultOrgId ? { registerPacks: (packs: LoadedDomainPack[]) => registerDomainPackRecords(database.db, defaultOrgId, packs) } : {}),
  };
  if (!baseUrl || !defaultOrgId || !kmsKeyName || !projectId) {
    return { auth: new UnavailableAuthService(), ...runtime };
  }
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
    ...runtime,
  };
}
