import { AuthTypes, Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { Pool } from "pg";

export async function createGoogleCloudSqlPool(input: {
  instanceConnectionName: string;
  database: string;
  user: string;
}, connector = new Connector()): Promise<{ pool: Pool; close: () => Promise<void> }> {
  try {
    const clientOptions = await connector.getOptions({
      instanceConnectionName: input.instanceConnectionName,
      // The shared instance has a public address only (architecture 6.2). The connector's TLS
      // tunnel and IAM authentication protect the connection; no network is authorised on it.
      ipType: IpAddressTypes.PUBLIC,
      authType: AuthTypes.IAM,
    });
    const pool = new Pool({
      ...clientOptions,
      user: input.user,
      database: input.database,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "fieldloop-web-api",
    });
    return {
      pool,
      close: async () => {
        await pool.end();
        connector.close();
      },
    };
  } catch (error) {
    connector.close();
    throw error;
  }
}
