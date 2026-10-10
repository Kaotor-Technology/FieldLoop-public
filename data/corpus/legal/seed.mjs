import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

const UUID_NAMESPACE_URL = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
const MANIFEST_URL = new URL("./manifest.json", import.meta.url);
const CREATED_BY = "seed:fl-65-legal-corpus";

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_URL, "utf8"));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Legal corpus requires ${fieldName}.`);
  }
}

export function validateManifest(manifest) {
  if (!isRecord(manifest) || !Array.isArray(manifest.records) || manifest.records.length === 0) {
    throw new Error("Legal corpus manifest must have a non-empty records array.");
  }
  if (manifest.recordCount !== manifest.records.length) {
    throw new Error("Legal corpus recordCount must match the records array.");
  }

  const seenKeys = new Set();
  for (const record of manifest.records) {
    if (!isRecord(record)) {
      throw new Error("Legal corpus contains an invalid document record.");
    }
    for (const fieldName of ["documentKey", "jurisdiction", "titleEn", "documentType", "revision", "status", "statusBasis", "folder", "classification", "licence", "contentState"]) {
      requireString(record[fieldName], `record.${fieldName}`);
    }
    if (seenKeys.has(record.documentKey)) {
      throw new Error(`Legal corpus repeats document key ${record.documentKey}.`);
    }
    seenKeys.add(record.documentKey);
    if (record.titleTh !== null && typeof record.titleTh !== "string") {
      throw new Error(`Legal corpus record ${record.documentKey} has an invalid Thai title.`);
    }
    if (!Array.isArray(record.sourceUrls) || record.sourceUrls.some((url) => typeof url !== "string")) {
      throw new Error(`Legal corpus record ${record.documentKey} must have a sourceUrls array.`);
    }
    if (typeof record.reviewRequired !== "boolean" || typeof record.simulated !== "boolean") {
      throw new Error(`Legal corpus record ${record.documentKey} requires reviewRequired and simulated booleans.`);
    }
    if (record.classification !== "public" || record.simulated !== false) {
      throw new Error(`Legal corpus record ${record.documentKey} must remain public and non-simulated.`);
    }
    if (record.reviewRequired && (record.status !== "status unverified" || record.contentPath !== null)) {
      throw new Error(`Unverified record ${record.documentKey} must require review and remain metadata-only.`);
    }
    if (record.status === "status unverified" && !record.reviewRequired) {
      throw new Error(`Unverified record ${record.documentKey} must require human review.`);
    }
    if (record.contentState === "full_text_snapshot" && typeof record.contentPath !== "string") {
      throw new Error(`Full-text record ${record.documentKey} requires a contentPath.`);
    }
    if (record.contentState === "metadata_only" && record.contentPath !== null) {
      throw new Error(`Metadata-only record ${record.documentKey} cannot reference a body file.`);
    }
  }
  return manifest;
}

function deterministicUuid(name) {
  const bytes = Buffer.from(
    createHash("sha1").update(UUID_NAMESPACE_URL).update(name, "utf8").digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function databaseId(orgId, documentKey) {
  return deterministicUuid(`fieldloop:fl-65:${orgId}:${documentKey}`);
}

function databaseTitle(record) {
  return record.titleTh ? `${record.titleTh} — ${record.titleEn}` : record.titleEn;
}

export function buildSeedQueries(database, manifest, orgId) {
  if (typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new Error("An Organisation ID is required.");
  }
  validateManifest(manifest);
  return manifest.records.map((record) => database
    .insertInto("app.controlled_document")
    .values({
      id: databaseId(orgId, record.documentKey),
      org_id: orgId,
      folder: record.folder,
      title: databaseTitle(record),
      revision: record.revision,
      status: record.status,
      classification: record.classification,
      licence: record.licence,
      // The deployment object-storage uploader is not part of FL-65.
      blob_uri: null,
      superseded_by: null,
      simulated: record.simulated,
      created_by: CREATED_BY,
    })
    .onConflict((conflict) => conflict.column("id").doUpdateSet((expression) => ({
      org_id: expression.ref("excluded.org_id"),
      folder: expression.ref("excluded.folder"),
      title: expression.ref("excluded.title"),
      revision: expression.ref("excluded.revision"),
      classification: expression.ref("excluded.classification"),
      licence: expression.ref("excluded.licence"),
      simulated: expression.ref("excluded.simulated"),
      created_by: expression.ref("excluded.created_by"),
    }))));
}

export async function loadSeed(database, manifest, orgId) {
  await database.transaction().execute(async (transaction) => {
    for (const query of buildSeedQueries(transaction, manifest, orgId)) {
      await query.execute();
    }
  });
}

function validateConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("FIELDLOOP_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("FIELDLOOP_DATABASE_URL must use postgres:// or postgresql://.");
  }
  if (!url.pathname.replace(/^\/+/, "") || !(url.searchParams.get("host") ?? url.hostname) || !url.username) {
    throw new Error("FIELDLOOP_DATABASE_URL must include a host, database name and user.");
  }
}

function parseArguments(argumentsList) {
  const options = { printSql: false, orgId: undefined, help: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--print-sql") {
      options.printSql = true;
    } else if (argument === "--org-id") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--org-id requires a value.");
      }
      options.orgId = value;
      index += 1;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function printUsage() {
  process.stdout.write([
    "Usage:",
    "  FIELDLOOP_ORG_ID=<org-id> FIELDLOOP_DATABASE_URL=<postgres-url> node data/corpus/legal/seed.mjs",
    "  node data/corpus/legal/seed.mjs --print-sql --org-id <org-id>",
    "",
  ].join("\n"));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const orgId = options.orgId ?? process.env.FIELDLOOP_ORG_ID;
  if (!orgId || orgId.trim().length === 0) {
    throw new Error("Set FIELDLOOP_ORG_ID or pass --org-id.");
  }
  const manifest = validateManifest(readManifest());
  const databaseUrl = process.env.FIELDLOOP_DATABASE_URL;
  if (!options.printSql && !databaseUrl) {
    throw new Error("Set FIELDLOOP_DATABASE_URL to the target database before loading the seed.");
  }
  if (!options.printSql) {
    validateConnectionString(databaseUrl);
  }

  const database = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: options.printSql ? undefined : databaseUrl,
        max: 1,
        connectionTimeoutMillis: 10_000,
      }),
    }),
  });
  try {
    if (options.printSql) {
      const queries = buildSeedQueries(database, manifest, orgId).map((query) => {
        const { sql: querySql, parameters } = query.compile();
        return { sql: querySql, parameters };
      });
      process.stdout.write(`${JSON.stringify(queries, null, 2)}\n`);
      return;
    }
    await loadSeed(database, manifest, orgId);
  } finally {
    await database.destroy();
  }
  process.stdout.write(`Loaded ${manifest.recordCount} Controlled Document records for Organisation ${orgId}.\n`);
}

const invokedAsScript = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Seed failed."}\n`);
    process.exitCode = 1;
  });
}
