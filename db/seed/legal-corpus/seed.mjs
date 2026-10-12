import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

const UUID_NAMESPACE_URL = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
const MANIFEST_URL = new URL("../../../data/corpus/legal/manifest.json", import.meta.url);
const CREATED_BY = "seed:fl-65-legal-corpus";
const STATUS_UNVERIFIED = "status unverified";
const CONTENT_FULL_TEXT = "full_text_snapshot";
const CONTENT_METADATA_ONLY = "metadata_only";

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
    for (const fieldName of ["documentKey", "jurisdiction", "titleEn", "documentType", "revision", "status", "statusBasis", "folder", "classification", "licence", "contentState", "legalStatus"]) {
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
    if (record.classification !== "PUBLIC" || record.simulated !== false) {
      throw new Error(`Legal corpus record ${record.documentKey} must remain public and non-simulated.`);
    }
    if (!["current", "superseded", "withdrawn", "draft", STATUS_UNVERIFIED].includes(record.status)) {
      throw new Error(`Legal corpus record ${record.documentKey} has an unknown lifecycle status.`);
    }
    if (record.reviewRequired && (record.status !== STATUS_UNVERIFIED || record.contentPath !== null)) {
      throw new Error(`Unverified record ${record.documentKey} must require review and remain metadata-only.`);
    }
    if (record.status === STATUS_UNVERIFIED && !record.reviewRequired) {
      throw new Error(`Unverified record ${record.documentKey} must require human review.`);
    }
    if (record.contentState !== CONTENT_FULL_TEXT && record.contentState !== CONTENT_METADATA_ONLY) {
      throw new Error(`Legal corpus record ${record.documentKey} has an unknown contentState.`);
    }
    if (record.status === "current" && record.contentState !== CONTENT_FULL_TEXT) {
      throw new Error(`Current record ${record.documentKey} requires a full source snapshot.`);
    }
    if (record.contentState === CONTENT_FULL_TEXT) {
      if (typeof record.contentPath !== "string") {
        throw new Error(`Full-text record ${record.documentKey} requires a contentPath.`);
      }
      if (!/^documents\/[a-z0-9.-]+$/.test(record.contentPath)) {
        throw new Error(`Full-text record ${record.documentKey} has an unsafe contentPath.`);
      }
      if (!existsSync(fileURLToPath(new URL(record.contentPath, MANIFEST_URL)))) {
        throw new Error(`Full-text record ${record.documentKey} points to a missing file.`);
      }
    }
    if (record.contentState === CONTENT_FULL_TEXT) {
      const bytes = readFileSync(new URL(record.contentPath, MANIFEST_URL));
      if (createHash("sha256").update(bytes).digest("hex") !== record.contentSha256) {
        throw new Error(`Source content hash mismatch for ${record.documentKey}.`);
      }
    }
    if (record.contentState === CONTENT_METADATA_ONLY && record.contentPath !== null) {
      throw new Error(`Metadata-only record ${record.documentKey} cannot reference a body file.`);
    }
  }
  return manifest;
}

export function validateStorage(manifest, storage) {
  validateManifest(manifest);
  if (!isRecord(storage) || !Array.isArray(storage.records)) {
    throw new Error("A verified storage manifest is required before loading legal text.");
  }
  const blobs = new Map();
  for (const blob of storage.records) {
    if (!isRecord(blob) || blobs.has(blob.documentKey)) throw new Error("Invalid or duplicate storage record.");
    const record = manifest.records.find((candidate) => candidate.documentKey === blob.documentKey);
    const textUri = record && `gs://${storage.bucket}/legal/${record.documentKey}/${record.contentSha256}/text`;
    const sourceUri = record?.sourceSha256
      ? `gs://${storage.bucket}/legal/${record.documentKey}/${record.sourceSha256}/source.pdf` : textUri;
    if (!record || record.contentState !== CONTENT_FULL_TEXT || blob.revision !== record.revision
      || blob.contentSha256 !== record.contentSha256 || (record.sourceSha256 && blob.sourceSha256 !== record.sourceSha256)
      || blob.blobUri !== sourceUri || blob.textBlobUri !== textUri) {
      throw new Error(`Storage binding mismatch for ${blob.documentKey}.`);
    }
    blobs.set(blob.documentKey, blob);
  }
  for (const record of manifest.records) {
    if (record.contentState === CONTENT_FULL_TEXT && !blobs.has(record.documentKey)) {
      throw new Error(`Missing stored full text for ${record.documentKey}.`);
    }
  }
  return blobs;
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

export function buildSeedQueries(database, manifest, orgId, storage = null) {
  if (typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new Error("An Organisation ID is required.");
  }
  validateManifest(manifest);
  const blobs = storage === null ? new Map() : validateStorage(manifest, storage);
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
      blob_uri: blobs.get(record.documentKey)?.blobUri ?? null,
      superseded_by: null,
      simulated: record.simulated,
      created_by: CREATED_BY,
    })
    .onConflict((conflict) => conflict.column("id").doUpdateSet((expression) => ({
      org_id: expression.ref("excluded.org_id"),
      folder: expression.ref("excluded.folder"),
      title: expression.ref("excluded.title"),
      revision: expression.ref("excluded.revision"),
      blob_uri: expression.fn.coalesce("controlled_document.blob_uri", "excluded.blob_uri"),
      // Preserve lifecycle decisions; migrate legacy legal-force labels.
      // Only unverified records follow subsequent manifest verification.
      status: expression
        .case()
        .when("controlled_document.status", "in", [STATUS_UNVERIFIED, "in force", "current plan period"])
        .then(expression.ref("excluded.status"))
        .else(expression.ref("controlled_document.status"))
        .end(),
      classification: expression.ref("excluded.classification"),
      licence: expression.ref("excluded.licence"),
      simulated: expression.ref("excluded.simulated"),
      created_by: expression.ref("excluded.created_by"),
    })).where((expression) => expression.and([
      expression("controlled_document.revision", "=", expression.ref("excluded.revision")),
      expression.or([
        expression("controlled_document.blob_uri", "is", null),
        expression("excluded.blob_uri", "is", null),
        expression("controlled_document.blob_uri", "=", expression.ref("excluded.blob_uri")),
      ]),
    ]))));
}

export async function loadSeed(database, manifest, orgId, storage) {
  validateStorage(manifest, storage);
  await database.transaction().execute(async (transaction) => {
    for (const query of buildSeedQueries(transaction, manifest, orgId, storage)) {
      const result = await query.executeTakeFirst();
      if (result.numInsertedOrUpdatedRows === 0n) {
        throw new Error("Controlled Document revision cannot change in place or replace its bound source; create a new document key and supersede the old record through the document workflow.");
      }
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
  const options = { printSql: false, orgId: undefined, storageManifest: undefined, help: false };
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
    } else if (argument === "--storage-manifest") {
      const value = argumentsList[++index];
      if (!value || value.startsWith("--")) throw new Error("--storage-manifest requires a file.");
      options.storageManifest = value;
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
    "  FIELDLOOP_ORG_ID=<org-id> FIELDLOOP_DATABASE_URL=<postgres-url> node db/seed/legal-corpus/seed.mjs",
    "  node db/seed/legal-corpus/seed.mjs --print-sql --org-id <org-id>",
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
  const storagePath = options.storageManifest ?? process.env.FIELDLOOP_STORAGE_MANIFEST;
  const storage = storagePath ? JSON.parse(readFileSync(storagePath, "utf8")) : null;
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
      const queries = buildSeedQueries(database, manifest, orgId, storage).map((query) => {
        const { sql: querySql, parameters } = query.compile();
        return { sql: querySql, parameters };
      });
      process.stdout.write(`${JSON.stringify(queries, null, 2)}\n`);
      return;
    }
    await loadSeed(database, manifest, orgId, storage);
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
