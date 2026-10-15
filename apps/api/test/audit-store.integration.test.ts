import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "../src/auth/service.js";
import { AuditServiceError } from "../src/audit/model.js";
import { PostgresHealthStore } from "../src/health/postgres-store.js";
import { PostgresAuditStore } from "../src/audit/postgres-store.js";

const databaseUrl = process.env["FIELDLOOP_AUDIT_TEST_DATABASE_URL"];
const integration = describe.skipIf(!databaseUrl);
type Classification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "HIGHLY_RESTRICTED";
let pool: Pool;
let store: PostgresAuditStore;
const orgId = `audit-api-${randomUUID()}`;
const otherOrgId = `audit-api-other-${randomUUID()}`;
const digest = (letter: string) => letter.repeat(64);

function user(clearance: Classification, organisation = orgId): CurrentUser {
  return { sub: "synthetic-manager", roles: ["fieldloop.manager"], persona: "Integrity Manager", orgId: organisation, clearance,
    csrfToken: "fixture", authTime: new Date() };
}
async function append(organisation: string, action: string, entity: string, classification: Classification, simulated = false) {
  await pool.query("SELECT * FROM app.append_audit_event($1, 'synthetic-user', $2, $3, NULL, $4, $5, $6)",
    [organisation, action, entity, digest("a"), simulated, classification]);
}

integration("PostgresAuditStore against migrated PostgreSQL", () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("FIELDLOOP_AUDIT_TEST_DATABASE_URL is required for PostgreSQL audit integration tests");
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    store = new PostgresAuditStore(new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool }) }));
    await append(orgId, "barrier.health_changed", "barrier-1", "INTERNAL");
    await append(orgId, "health_proposal.accepted", "proposal-1", "CONFIDENTIAL");
    await append(orgId, "barrier.health_changed", "barrier-2", "INTERNAL", true);
    await append(orgId, "simulation.reset", "run-1", "HIGHLY_RESTRICTED", true);
    await append(orgId, "barrier.health_changed", "barrier-1", "PUBLIC");
    await append(otherOrgId, "barrier.health_changed", "barrier-1", "PUBLIC");
  });
  afterAll(async () => { await pool?.end(); });

  it.each(["accept", "reject"] as const)("shows only the hash-bound reason of a real %s decision", async (decision) => {
    const organisation = `audit-decision-${randomUUID()}`;
    const actor = user("CONFIDENTIAL", organisation);
    const ownerId = randomUUID(), barrierId = randomUUID(), proposalId = randomUUID();
    await pool.query("INSERT INTO app.app_user (id,org_id,keycloak_sub,roles_snapshot) VALUES ($1,$2,$3,'[\"fieldloop.manager\"]'::jsonb)", [ownerId, organisation, actor.sub]);
    await pool.query("INSERT INTO app.barrier (id,org_id,type,side,health,owner_id,simulated,classification) VALUES ($1,$2,'technical','preventive','healthy',$3,true,'CONFIDENTIAL')", [barrierId, organisation, ownerId]);
    await pool.query("INSERT INTO app.health_proposal (id,org_id,barrier_id,proposed_health,status,simulated,classification) VALUES ($1,$2,$3,'degraded','open',true,'CONFIDENTIAL')", [proposalId, organisation, barrierId]);
    const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool }) });
    const reason = `Synthetic owner ${decision} reason`;
    await new PostgresHealthStore(db).decide({ user: actor, proposalId, decision, reason, idempotencyKey: randomUUID() });
    const events = await store.listEvents(actor, { entityId: proposalId }, undefined, 50);
    expect(events.items).toHaveLength(1);
    expect(events.items[0]).toMatchObject({ actor: actor.sub, reason, action: `health_proposal.${decision === "accept" ? "accepted" : "rejected"}` });
    expect((await store.listEvents(user("PUBLIC", organisation), { entityId: proposalId }, undefined, 50)).items).toEqual([]);
    expect((await store.listEvents(user("HIGHLY_RESTRICTED", "another-org"), { entityId: proposalId }, undefined, 50)).items).toEqual([]);
    // The audit row is immutable; later domain changes must not substitute an unbound reason.
    await pool.query("UPDATE app.health_proposal SET reason='Unbound replacement' WHERE id=$1", [proposalId]);
    expect((await store.listEvents(actor, { entityId: proposalId }, undefined, 50)).items[0]).toMatchObject({ reason: null });
    await pool.query("UPDATE app.health_proposal SET reason=$1,classification='HIGHLY_RESTRICTED' WHERE id=$2", [reason, proposalId]);
    expect((await store.listEvents(actor, { entityId: proposalId }, undefined, 50)).items[0]).toMatchObject({ reason: null });
  });

  it("returns only the user's Organisation, newest first, with the stored hash chain", async () => {
    const page = await store.listEvents(user("HIGHLY_RESTRICTED"), {}, undefined, 50);
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.entity)).toEqual(["barrier-1", "run-1", "barrier-2", "proposal-1", "barrier-1"]);
    for (let i = 0; i < page.items.length - 1; i++) expect(page.items[i]?.prevHash).toBe(page.items[i + 1]?.hash);
    expect(page.items.at(-1)?.prevHash).toBeNull();
    expect(page.items[0]).toMatchObject({ entityType: "barrier", action: "barrier.health_changed", actor: "synthetic-user",
      beforeHash: null, afterHash: digest("a"), simulated: false, classification: "PUBLIC" });
    expect(page.items[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect((await store.listEvents(user("HIGHLY_RESTRICTED", otherOrgId), {}, undefined, 50)).items).toHaveLength(1);
    expect((await store.listEvents(user("HIGHLY_RESTRICTED", "audit-api-nobody"), {}, undefined, 50)).items).toEqual([]);
  });

  it("hides events above the user's clearance", async () => {
    const internal = await store.listEvents(user("INTERNAL"), {}, undefined, 50);
    expect(internal.items.map((item) => item.classification).sort()).toEqual(["INTERNAL", "INTERNAL", "PUBLIC"]);
    const confidential = await store.listEvents(user("CONFIDENTIAL"), {}, undefined, 50);
    expect(confidential.items).toHaveLength(4);
    expect(confidential.items.some((item) => item.classification === "HIGHLY_RESTRICTED")).toBe(false);
    await expect(store.listEvents(user("SECRET" as Classification), {}, undefined, 50)).rejects.toMatchObject({ status: 403 });
  });

  it("filters by action namespace and exact entity", async () => {
    const barrierEvents = await store.listEvents(user("HIGHLY_RESTRICTED"), { entityType: "barrier" }, undefined, 50);
    expect(barrierEvents.items.map((item) => item.entity)).toEqual(["barrier-1", "barrier-2", "barrier-1"]);
    const entity = await store.listEvents(user("HIGHLY_RESTRICTED"), { entityId: "barrier-1" }, undefined, 50);
    expect(entity.items).toHaveLength(2);
    const both = await store.listEvents(user("HIGHLY_RESTRICTED"), { entityType: "health_proposal", entityId: "proposal-1" }, undefined, 50);
    expect(both.items).toHaveLength(1);
    expect((await store.listEvents(user("HIGHLY_RESTRICTED"), { entityType: "health_proposal", entityId: "barrier-1" }, undefined, 50)).items).toEqual([]);
    // LIKE wildcards are not interpreted: "_" must not match any character.
    expect((await store.listEvents(user("HIGHLY_RESTRICTED"), { entityType: "barrie_" }, undefined, 50)).items).toEqual([]);
  });

  it("pages without gaps or repeats, even for events created in the same millisecond", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await store.listEvents(user("HIGHLY_RESTRICTED"), {}, cursor, 2);
      seen.push(...page.items.map((item) => item.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const all = await store.listEvents(user("HIGHLY_RESTRICTED"), {}, undefined, 50);
    expect(seen).toEqual(all.items.map((item) => item.id));
    expect(new Set(seen).size).toBe(5);
  });

  it("rejects a forged or malformed cursor", async () => {
    for (const cursor of ["not-base64-json", Buffer.from(JSON.stringify({ createdAt: "2026-10-14T00:00:00.000Z", id: randomUUID() })).toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "2026-10-14T00:00:00.000000Z", id: "x'; DROP TABLE app.audit_event; --" })).toString("base64url")]) {
      await expect(store.listEvents(user("HIGHLY_RESTRICTED"), {}, cursor, 5)).rejects.toBeInstanceOf(AuditServiceError);
    }
  });
});
