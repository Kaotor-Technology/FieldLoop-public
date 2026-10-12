import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { loadSeed, readManifest } from "../db/seed/legal-corpus/seed.mjs";

const container = `fieldloop-legal-seed-${process.pid}`;
const image = `fieldloop-db-test:legal-${process.pid}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
let database;
try {
  execFileSync("docker", ["build", "-q", "-t", image, "-"], { input: readFileSync("db/test/Dockerfile"), stdio: ["pipe", "inherit", "inherit"] });
  docker("run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=fixture", "-e", "POSTGRES_DB=legal_fixture", "-p", "127.0.0.1::5432", image);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { docker("exec", container, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "postgres"); break; }
    catch { await setTimeout(500); }
  }
  const migrations = readdirSync("db/migrations").filter((name) => name.endsWith(".sql")).sort()
    .map((name) => readFileSync(`db/migrations/${name}`, "utf8").split("-- migrate:down")[0]).join("\n");
  execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "legal_fixture"], { input: migrations, stdio: ["pipe", "pipe", "pipe"] });
  const port = docker("port", container, "5432").trim().split(":").at(-1);
  database = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: `postgres://postgres:fixture@127.0.0.1:${port}/legal_fixture` }) }) });
  const manifest = readManifest();
  const storage = JSON.parse(readFileSync("data/corpus/legal/storage/dev.json", "utf8"));
  await loadSeed(database, manifest, "legal-fixture", storage);
  await loadSeed(database, manifest, "legal-fixture", storage);
  const rows = () => database.selectFrom("app.controlled_document").selectAll().orderBy("id").execute();
  const loaded = await rows();
  assert.equal(loaded.length, 18);
  assert.equal(loaded.filter((row) => row.status === "current").length, 5);
  assert.equal(loaded.filter((row) => row.blob_uri !== null).length, 9);
  assert.equal(loaded.filter((row) => row.status === "status unverified" && row.blob_uri === null).length, 8);

  // Reproduce a previous load that admitted text before the quality hold existed.
  const water = manifest.records.find((record) => record.documentKey === "TH-WATER-RESOURCES-2561");
  const waterRow = loaded.find((row) => row.title.includes(water.titleEn));
  assert.ok(waterRow);
  await database.updateTable("app.controlled_document").set({ status: "current" }).where("id", "=", waterRow.id).execute();
  await loadSeed(database, manifest, "legal-fixture", storage);
  assert.deepEqual(await rows(), loaded);
  assert.equal(loaded.filter((row) => row.status === "draft" && row.blob_uri !== null).length, 4);

  const changed = structuredClone(manifest), changedStorage = structuredClone(storage);
  changed.records[0].titleEn = "Changed fixture title that must roll back";
  changed.records[2].revision = "Different revision fixture";
  changedStorage.records.find((row) => row.documentKey === changed.records[2].documentKey).revision = changed.records[2].revision;
  await assert.rejects(loadSeed(database, changed, "legal-fixture", changedStorage), /revision cannot change in place/);
  assert.deepEqual(await rows(), loaded);

  await database.updateTable("app.controlled_document").set({ status: "withdrawn" }).where("id", "=", loaded[0].id).execute();
  await loadSeed(database, manifest, "legal-fixture", storage);
  assert.equal((await database.selectFrom("app.controlled_document").select("status").where("id", "=", loaded[0].id).executeTakeFirstOrThrow()).status, "withdrawn");
  console.log("Legal seed: 18 records, 9 stored sources, 5 current, 4 quarantined drafts; current-text retraction, rerun, revision rollback and human lifecycle preservation passed.");
} finally {
  if (database) await database.destroy();
  try { docker("rm", "-f", container); } catch { /* The container may not have started. */ }
  try { docker("image", "rm", image); } catch { /* Never remove a shared test image. */ }
}
