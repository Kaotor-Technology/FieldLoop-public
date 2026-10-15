import { Kysely, PostgresDialect, type ColumnType, type Generated } from "kysely";
import { createGoogleCloudSqlPool } from "@fieldloop/adapters";
import { Pool } from "pg";
import type { AuthStore, AuthUser, OidcTransaction } from "./model.js";

type Timestamp = ColumnType<Date, Date | string, Date | string>;

interface AppUserTable {
  id: Generated<string>;
  org_id: string;
  keycloak_sub: string;
  display_name: string | null;
  roles_snapshot: ColumnType<string[] | null, string | null | undefined, string>;
  created_at: Generated<Timestamp>;
  created_by: ColumnType<string | null, string | null | undefined, string | null>;
}

interface UserSessionTable {
  id: Generated<string>;
  org_id: string;
  session_id: string;
  app_user_id: string;
  keycloak_sid: string | null;
  access_token: Buffer;
  refresh_token: Buffer | null;
  id_token: Buffer;
  wrapped_data_key: Buffer;
  auth_time: Timestamp;
  roles: ColumnType<string[], string, string>;
  clearance: string;
  csrf_token: string;
  last_validated_at: Timestamp;
  last_active_at: Timestamp;
  access_expires_at: Timestamp;
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
  created_by: ColumnType<string | null, string | null | undefined, string | null>;
}

interface OidcLoginTransactionTable {
  id: Generated<string>;
  org_id: string;
  simulated: boolean;
  classification: string;
  state_hash: string;
  nonce: string;
  pkce_verifier: Buffer;
  wrapped_data_key: Buffer;
  return_path: string;
  reauth_session_id: string | null;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
}

export interface AuthDatabase {
  app_user: AppUserTable;
  user_session: UserSessionTable;
  oidc_login_transaction: OidcLoginTransactionTable;
}

export function createAuthDatabase(connectionString: string): { db: Kysely<AuthDatabase>; pool: Pool } {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "fieldloop-web-api",
  });
  const db = new Kysely<AuthDatabase>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

export async function createCloudSqlAuthDatabase(input: {
  instanceConnectionName: string;
  database: string;
  user: string;
}): Promise<{ db: Kysely<AuthDatabase>; pool: Pool; close: () => Promise<void> }> {
  const connection = await createGoogleCloudSqlPool(input);
  const db = new Kysely<AuthDatabase>({ dialect: new PostgresDialect({ pool: connection.pool }) });
  return { db, pool: connection.pool, close: connection.close };
}

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly db: Kysely<AuthDatabase>) {}

  async createTransaction(transaction: OidcTransaction): Promise<void> {
    await this.db
      .withSchema("app")
      .deleteFrom("oidc_login_transaction")
      .where("expires_at", "<", new Date())
      .execute();

    await this.db
      .withSchema("app")
      .insertInto("oidc_login_transaction")
      .values({
        org_id: transaction.orgId,
        simulated: false,
        classification: "INTERNAL",
        state_hash: transaction.stateHash,
        nonce: transaction.nonce,
        pkce_verifier: transaction.encryptedCodeVerifier,
        wrapped_data_key: transaction.wrappedDataKey,
        return_path: transaction.returnPath,
        reauth_session_id: transaction.reauthSessionHash,
        expires_at: transaction.expiresAt,
      })
      .execute();
  }

  async consumeTransaction(stateHash: string): Promise<OidcTransaction | undefined> {
    const row = await this.db
      .withSchema("app")
      .deleteFrom("oidc_login_transaction")
      .where("state_hash", "=", stateHash)
      .returning([
        "state_hash",
        "nonce",
        "pkce_verifier",
        "wrapped_data_key",
        "return_path",
        "reauth_session_id",
        "org_id",
        "expires_at",
      ])
      .executeTakeFirst();

    if (!row || row.expires_at.getTime() <= Date.now()) return undefined;
    return {
      stateHash: row.state_hash,
      nonce: row.nonce,
      encryptedCodeVerifier: row.pkce_verifier,
      wrappedDataKey: row.wrapped_data_key,
      returnPath: row.return_path,
      reauthSessionHash: row.reauth_session_id,
      orgId: row.org_id,
      expiresAt: row.expires_at,
    };
  }

  async findSession(sessionHash: string): Promise<AuthUser | undefined> {
    const row = await this.db
      .withSchema("app")
      .selectFrom("user_session as s")
      .innerJoin("app_user as u", "u.id", "s.app_user_id")
      .select([
        "s.app_user_id as userId",
        "s.org_id as orgId",
        "u.keycloak_sub as sub",
        "u.display_name as displayName",
        "s.keycloak_sid as sid",
        "s.roles as roles",
        "s.clearance as clearance",
        "s.csrf_token as csrfToken",
        "s.auth_time as authTime",
        "s.last_validated_at as lastValidatedAt",
        "s.last_active_at as lastActiveAt",
        "s.access_expires_at as accessExpiresAt",
        "s.expires_at as expiresAt",
        "s.wrapped_data_key as wrappedDataKey",
        "s.access_token as accessToken",
        "s.refresh_token as refreshToken",
        "s.id_token as idToken",
      ])
      .where("s.session_id", "=", sessionHash)
      .executeTakeFirst();

    if (!row) return undefined;
    return {
      userId: row.userId,
      orgId: row.orgId,
      sub: row.sub,
      displayName: row.displayName,
      sid: row.sid,
      roles: row.roles,
      clearance: row.clearance,
      csrfToken: row.csrfToken,
      authTime: row.authTime,
      lastValidatedAt: row.lastValidatedAt,
      lastActiveAt: row.lastActiveAt,
      accessExpiresAt: row.accessExpiresAt,
      expiresAt: row.expiresAt,
      wrappedDataKey: row.wrappedDataKey,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      idToken: row.idToken,
    };
  }

  async markSessionValidated(sessionHash: string, lastValidatedAt: Date): Promise<void> {
    const result = await this.db
      .withSchema("app")
      .updateTable("user_session")
      .set({ last_validated_at: lastValidatedAt })
      .where("session_id", "=", sessionHash)
      .executeTakeFirst();
    if (BigInt(result.numUpdatedRows) !== 1n) throw new Error("Session ended during validation");
  }

  async saveSession(input: Parameters<AuthStore["saveSession"]>[0]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const user = await trx
        .withSchema("app")
        .insertInto("app_user")
        .values({
          org_id: input.orgId,
          keycloak_sub: input.sub,
          display_name: input.displayName,
          roles_snapshot: JSON.stringify(input.roles),
        })
        .onConflict((conflict) =>
          conflict.columns(["org_id", "keycloak_sub"]).doUpdateSet({
            display_name: input.displayName,
            roles_snapshot: JSON.stringify(input.roles),
          }),
        )
        .returning("id")
        .executeTakeFirstOrThrow();

      const values = {
        org_id: input.orgId,
        session_id: input.sessionHash,
        app_user_id: user.id,
        keycloak_sid: input.sid,
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
        id_token: input.idToken,
        wrapped_data_key: input.wrappedDataKey,
        auth_time: input.authTime,
        roles: JSON.stringify(input.roles),
        clearance: input.clearance,
        csrf_token: input.csrfToken,
        last_validated_at: input.lastValidatedAt,
        last_active_at: input.lastActiveAt,
        access_expires_at: input.accessExpiresAt,
        expires_at: input.expiresAt,
      };

      if (input.existingSessionHash) {
        const existing = await trx
          .withSchema("app")
          .selectFrom("user_session")
          .innerJoin("app_user", "app_user.id", "user_session.app_user_id")
          .select("app_user.keycloak_sub as sub")
          .where("user_session.session_id", "=", input.existingSessionHash)
          .forUpdate()
          .executeTakeFirst();
        if (!existing || existing.sub !== input.sub) throw new Error("Reauthentication user does not match the active session");

        const result = await trx
          .withSchema("app")
          .updateTable("user_session")
          .set({ ...values, session_id: input.existingSessionHash })
          .where("session_id", "=", input.existingSessionHash)
          .executeTakeFirst();
        if (BigInt(result.numUpdatedRows) !== 1n) throw new Error("Session expired during reauthentication");
      } else {
        await trx.withSchema("app").insertInto("user_session").values(values).execute();
      }
    });
  }

  async touchSession(sessionHash: string, lastActiveAt: Date): Promise<void> {
    const result = await this.db
      .withSchema("app")
      .updateTable("user_session")
      .set({ last_active_at: lastActiveAt })
      .where("session_id", "=", sessionHash)
      .executeTakeFirst();
    if (BigInt(result.numUpdatedRows) !== 1n) throw new Error("Session ended while its request was active");
  }

  async updateTokens(input: Parameters<AuthStore["updateTokens"]>[0]): Promise<void> {
    const result = await this.db
      .withSchema("app")
      .updateTable("user_session")
      .set({
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
        access_expires_at: input.accessExpiresAt,
        last_validated_at: input.lastValidatedAt,
      })
      .where("session_id", "=", input.sessionHash)
      .executeTakeFirst();
    if (BigInt(result.numUpdatedRows) !== 1n) throw new Error("Session ended during token refresh");
  }

  async deleteSession(sessionHash: string): Promise<void> {
    await this.db.withSchema("app").deleteFrom("user_session").where("session_id", "=", sessionHash).execute();
  }

  async deleteSessionsBySid(sid: string): Promise<void> {
    await this.db.withSchema("app").deleteFrom("user_session").where("keycloak_sid", "=", sid).execute();
  }
}
