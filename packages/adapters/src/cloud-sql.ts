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
      // The shared instance is reached at its private address, over the Direct VPC egress of the
      // service (ADR-0009). The connector's TLS and IAM authentication still apply.
      ipType: IpAddressTypes.PRIVATE,
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
