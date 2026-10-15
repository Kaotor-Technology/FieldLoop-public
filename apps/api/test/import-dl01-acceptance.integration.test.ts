import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import type { CurrentUser } from "../src/auth/service.js";
import { PostgresImportStore, type ImportMapping } from "../src/imports/store.js";

// FL-48 acceptance: the synthetic DL-01 seed, the wizard store and the committed KML fixtures together.
const url = process.env["FIELDLOOP_IMPORT_TEST_DATABASE_URL"];
const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (name: string) => readFileSync(new URL(`../../../data/synthetic/dl-01/${name}`, import.meta.url));

describe.skipIf(!url)("FL-48 DL-01 encroachment KML import against the seeded PostGIS", () => {
  let pool: Pool, db: Kysely<Record<string, never>>, store: PostgresImportStore;
  let user: CurrentUser, mapping: ImportMapping, barrierId: string;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    store = new PostgresImportStore(db);
    const orgId = randomUUID();
    execFileSync("pnpm", ["db:seed:dl-01"], { cwd: root, stdio: "pipe", env: { ...process.env, FIELDLOOP_ORG_ID: orgId, FIELDLOOP_DATABASE_URL: url } });
    // The seed leaves the Organisation boundary unset; give the fixture one around the synthetic route.
    await pool.query("UPDATE app.organisation SET import_area=ST_Multi(ST_GeomFromText('POLYGON((99 18,100.5 18,100.5 19.6,99 19.6,99 18))',4326)) WHERE org_id=$1", [orgId]);
    user = { sub: "synthetic-risk-engineer", orgId, roles: ["fieldloop.operator"], persona: "Integrity Engineer", clearance: "HIGHLY_RESTRICTED", csrfToken: "csrf", authTime: new Date() };
    const choices = await store.options(user);
    const patrol = choices.barriers.find((barrier) => barrier.name === "Right-of-Way patrol");
    expect(patrol, "seeded Right-of-Way patrol Barrier is offered by the wizard").toBeDefined();
    barrierId = (patrol as { id: string }).id;
    mapping = { assetId: (patrol as { assetId: string }).assetId, toleranceMetres: 50, nameField: "name", descriptionField: "description", categoryField: "ExtendedData.category", target: "evidence", barrierId };
  });
  afterAll(async () => { await db?.destroy(); });

  it("Happy: 10 points near DL-01 become 10 located Evidence records on the patrol Barrier", async () => {
    const bytes = fixture("encroachment-points.kml");
    const created = await store.create(user, bytes, "kml", randomUUID());
    expect(created.points).toHaveLength(10);
    const mapped = await store.map(user, created.id, created.version, mapping);
    const chainages = mapped.points.map((point) => point.chainageMetres);
    expect(chainages.every((value) => typeof value === "number")).toBe(true);
    expect(chainages).toEqual([...chainages].sort((a, b) => (a as number) - (b as number)));
    expect(mapped.points.every((point) => (point.distanceMetres as number) <= 50)).toBe(true);
    expect(mapped.points.flatMap((point) => point.flags)).toEqual([]);
    const healthBefore = (await pool.query("SELECT health FROM app.barrier WHERE id=$1", [barrierId])).rows;
    const committed = await store.command(user, mapped.id, mapped.version, "commit", randomUUID());
    expect(committed.status).toBe("committed");
    const evidence = await pool.query("SELECT barrier_id,kind,simulated,classification,created_by FROM app.evidence WHERE org_id=$1 AND kind='kml_import'", [user.orgId]);
    expect(evidence.rows).toHaveLength(10);
    expect(new Set(evidence.rows.map((row) => row.barrier_id))).toEqual(new Set([barrierId]));
    expect(evidence.rows.every((row) => row.simulated === true && row.created_by === user.sub && row.classification === "HIGHLY_RESTRICTED")).toBe(true);
    const items = await pool.query("SELECT snapped_chainage FROM app.kml_import_item WHERE kml_import_id=$1 AND target='evidence'", [created.id]);
    expect(items.rows).toHaveLength(10);
    expect(items.rows.every((row) => row.snapped_chainage !== null)).toBe(true);
    const provenance = (await pool.query("SELECT file_hash,created_by,classification FROM app.kml_import WHERE id=$1", [created.id])).rows[0];
    expect(provenance).toEqual({ file_hash: createHash("sha256").update(bytes).digest("hex"), created_by: user.sub, classification: "HIGHLY_RESTRICTED" });
    expect((await pool.query("SELECT health FROM app.barrier WHERE id=$1", [barrierId])).rows).toEqual(healthBefore);
  });

  it("Edge: a point 80 m from the route is flagged and receives no Chainage", async () => {
    const created = await store.create(user, fixture("encroachment-outside-tolerance.kml"), "kml", randomUUID());
    const mapped = await store.map(user, created.id, created.version, mapping);
    expect(mapped.points).toHaveLength(1);
    expect(mapped.points[0]?.chainageMetres).toBeNull();
    expect(mapped.points[0]?.flags).toContain("outside_snap_tolerance");
    expect(mapped.points[0]?.distanceMetres).toBeCloseTo(80, 0);
  });

  it("Error: a damaged file is rejected with a reason and creates no import record", async () => {
    const before = (await pool.query("SELECT count(*)::int AS count FROM app.kml_import WHERE org_id=$1", [user.orgId])).rows[0]?.count;
    await expect(store.create(user, Buffer.from("<kml><Document><Placemark>"), "kml", randomUUID())).rejects.toMatchObject({ status: 400, code: "invalid_kml" });
    expect((await pool.query("SELECT count(*)::int AS count FROM app.kml_import WHERE org_id=$1", [user.orgId])).rows[0]?.count).toBe(before);
  });
});
