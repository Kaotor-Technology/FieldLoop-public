import { GoogleModelArmorAdapter, GoogleVertexChatCompletionsAdapter, createGoogleCloudSqlPool } from "@fieldloop/adapters";
import { Kysely, PostgresDialect } from "kysely";
import { buildApp } from "./app.js";
import { PostgresGuardrailStore } from "./postgres-store.js";

type Database = Record<string, never>;

const port = readPort(process.env["PORT"] ?? "8080");
const projectId = requiredEnv("GOOGLE_CLOUD_PROJECT");
const location = process.env["FIELDLOOP_VERTEX_LOCATION"] ?? "asia-southeast1";
const environment = requiredEnv("FIELDLOOP_ENV");
if (environment !== "dev" && environment !== "demo") throw new Error("FIELDLOOP_ENV must be dev or demo");
const orgId = requiredEnv("FIELDLOOP_DEFAULT_ORG_ID");
const database = requiredEnv("FIELDLOOP_DB_NAME");
const databaseUser = requiredEnv("FIELDLOOP_DB_USER");
const connectionName = requiredEnv("FIELDLOOP_DB_CONNECTION_NAME");
const simulated = parseBooleanEnv(process.env["SIMULATED"] ?? "true");

const { pool, close } = await createGoogleCloudSqlPool({
  instanceConnectionName: connectionName,
  database,
  user: databaseUser,
  maxConnections: 5,
  applicationName: "fieldloop-guardrail",
});
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
const scanner = new GoogleModelArmorAdapter({
  projectId,
  location: requiredEnv("FIELDLOOP_MODEL_ARMOR_LOCATION"),
  templateId: requiredEnv("FIELDLOOP_MODEL_ARMOR_TEMPLATE_ID"),
  timeoutMs: readPositiveIntegerEnv("FIELDLOOP_TIER1_TIMEOUT_MS", "1000", 30_000),
});
const model = new GoogleVertexChatCompletionsAdapter({
  projectId,
  location,
  timeoutMs: readPositiveIntegerEnv("FIELDLOOP_VERTEX_TIMEOUT_MS", "60000", 300_000),
});
const app = buildApp({
  store: new PostgresGuardrailStore(db),
  scanner,
  model,
  orgId,
  simulated,
  vertexModels: {
    flash: requiredEnv("FIELDLOOP_VERTEX_MODEL_FLASH"),
    pro: requiredEnv("FIELDLOOP_VERTEX_MODEL_PRO"),
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.close().then(close).catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  await close();
  process.exitCode = 1;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value) throw new Error(`${name} must be configured`);
  return value;
}

function readPositiveIntegerEnv(name: string, fallback: string, maximum: number): number {
  const raw = process.env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be between 1 and ${maximum}`);
  return value;
}

function parseBooleanEnv(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("SIMULATED must be true or false");
}

function readPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer between 1 and 65535");
  return port;
}
