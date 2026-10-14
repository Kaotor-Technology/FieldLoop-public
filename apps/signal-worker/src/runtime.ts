import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { PostgresActionStore, createGoogleCloudSqlPool, createGooglePubSubTransport, GoogleServiceIdentityVerifier } from "@fieldloop/adapters";
import type { WorkerRuntime } from "./model.js";
import { PostgresWorkerStore, type SourceInterval } from "./postgres-store.js";

export async function createWorkerRuntime(env: NodeJS.ProcessEnv = process.env): Promise<WorkerRuntime | undefined> {
  const databaseUrl = env["DATABASE_URL"];
  const connectionName = env["FIELDLOOP_DB_CONNECTION_NAME"];
  // Preserve dependency-free container health checks; configured deployments fail startup on missing settings.
  if (!databaseUrl && !connectionName) return undefined;
  const requireSetting = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`${name} is required for the Signal worker`);
    return value;
  };
  const orgId = requireSetting("FIELDLOOP_DEFAULT_ORG_ID");
  const environment = requireSetting("FIELDLOOP_ENV");
  const audience = requireSetting("FIELDLOOP_WORKER_AUDIENCE");
  const pushEmail = requireSetting("FIELDLOOP_PUBSUB_PUSH_EMAIL");
  const schedulerEmail = requireSetting("FIELDLOOP_SCHEDULER_EMAIL");
  const subscription = requireSetting("FIELDLOOP_SIGNAL_SUBSCRIPTION");
  const projectId = requireSetting("GOOGLE_CLOUD_PROJECT");
  const topic = env["FIELDLOOP_DOMAIN_EVENT_TOPIC"] ?? "domain-events";
  const calendarTimeZone = env["FIELDLOOP_MEASUREMENT_TIME_ZONE"] ?? "Asia/Bangkok";
  new Intl.DateTimeFormat("en-US", { timeZone: calendarTimeZone }).format();
  const intervals: unknown = JSON.parse(requireSetting("FIELDLOOP_SOURCE_INTERVALS"));
  if (!intervals || typeof intervals !== "object" || Array.isArray(intervals)
    || !Object.values(intervals).every((value) => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 31_536_000)
      || (value && typeof value === "object" && Object.keys(value).length === 1 && "months" in value
        && typeof value.months === "number" && Number.isInteger(value.months) && value.months >= 1 && value.months <= 12))) {
    throw new Error("FIELDLOOP_SOURCE_INTERVALS must map sources to positive periodic measurement seconds or {months:1..12}");
  }
  if (!["local", "dev", "demo"].includes(environment) || !/^[a-zA-Z][a-zA-Z0-9._~-]{2,254}$/.test(topic)) throw new Error("Invalid worker routing settings");
  if (env["SIMULATED"] !== "true" && env["SIMULATED"] !== "false") throw new Error("SIMULATED must be explicitly true or false");
  if (environment === "demo" && env["SIMULATED"] !== "true") throw new Error("Demo worker requires SIMULATED=true");
  const connection = databaseUrl ? { pool: new Pool({ connectionString: databaseUrl, max: 5 }) }
    : await createGoogleCloudSqlPool({ instanceConnectionName: connectionName ?? "", database: requireSetting("FIELDLOOP_DB_NAME"), user: requireSetting("FIELDLOOP_DB_USER") });
  const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: connection.pool }) });
  const pubsub = createGooglePubSubTransport(projectId);
  const close = async () => {
    try { await pubsub.close(); }
    finally {
      if ("close" in connection) await connection.close();
      else await db.destroy();
    }
  };
  try {
    const store = new PostgresWorkerStore(db, orgId, intervals as Record<string, SourceInterval>, calendarTimeZone);
    await store.initialize();
    const actions = new PostgresActionStore(db);
    return { expireActions: () => actions.expire(orgId, env["SIMULATED"] === "true"), store, identity: new GoogleServiceIdentityVerifier(), audience, pushEmail, schedulerEmail,
      subscription, orgId, environment, simulatedOnly: env["SIMULATED"] === "true", close,
      publish: async (event) => {
        await pubsub.transport.publish(topic, Buffer.from(JSON.stringify(event)), {
          environment, orgId, eventId: event.id, eventType: event.type, simulated: String(event.simulated), classification: event.classification,
        });
      } };
  } catch (error) { await close(); throw error; }
}
