import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { CurrentUser } from "../src/auth/service.js";
import { DraftServiceError } from "../src/drafts/model.js";
import { PostgresDraftStore } from "../src/drafts/postgres-store.js";

const databaseUrl = process.env["FIELDLOOP_DRAFT_TEST_DATABASE_URL"] ?? process.env["FIELDLOOP_ACTION_TEST_DATABASE_URL"];
const integration = describe.skipIf(!databaseUrl);
type Classification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "HIGHLY_RESTRICTED";
let pool: Pool;
let db: Kysely<Record<string, never>>;
let store: PostgresDraftStore;

function user(sub: string, clearance: Classification = "INTERNAL"): CurrentUser {
  return { sub, displayName: "Synthetic Reviewer", roles: ["fieldloop.operator"], persona: "Integrity Engineer",
    orgId: `draft-test-${sub}`, clearance, csrfToken: "fixture", authTime: new Date() };
}

async function insertDraft(orgId: string, createdBy: string, classification: Classification = "INTERNAL") {
  const id = randomUUID();
  await pool.query(`INSERT INTO app.draft
      (id, org_id, kind, content, citations, confidence, status, simulated, classification, created_by)
    VALUES ($1, $2, 'management_summary', $3, $4::jsonb, 0.8, 'needs_approval', true, $5, $6)`,
  [id, orgId, "Synthetic risk summary: 4", JSON.stringify(["/api/v1/bowties/synthetic/risk"]), classification, createdBy]);
  return id;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

integration("PostgresDraftStore against migrated PostgreSQL", () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error("FIELDLOOP_DRAFT_TEST_DATABASE_URL is required for PostgreSQL Draft integration tests");
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    store = new PostgresDraftStore(db);
  });
  afterAll(async () => { await db?.destroy(); });

  it("approves only for another person, persists the content hash and replays idempotently", async () => {
    const reviewer = user(randomUUID());
    const draftId = await insertDraft(reviewer.orgId, "agent:report-generator on_behalf_of:synthetic-author");
    const idempotencyKey = randomUUID();
    const approved = await store.decide({ user: reviewer, draftId, decision: "approve", idempotencyKey });
    expect(approved).toMatchObject({ status: "approved", approvedBy: reviewer.displayName, simulated: true,
      approvalStamp: expect.stringMatching(/^AI-assisted, approved by Synthetic Reviewer, \d{4}-\d{2}-\d{2}$/) });

    const stored = (await pool.query(`SELECT content, citations, approved_content_hash, decision_key, decision_hash
      FROM app.draft WHERE id=$1`, [draftId])).rows[0] as {
        content: string; citations: string[]; approved_content_hash: string; decision_key: string; decision_hash: string;
      };
    expect(stored.approved_content_hash).toBe(sha256(JSON.stringify([stored.content, stored.citations])));
    expect(stored.decision_key).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.decision_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.decide({ user: reviewer, draftId, decision: "approve", idempotencyKey })).toEqual(approved);
    await expect(store.decide({ user: reviewer, draftId, decision: "reject", reason: "Different request", idempotencyKey }))
      .rejects.toMatchObject({ code: "idempotency_key_reused" });
    await expect(pool.query("UPDATE app.draft SET content='Changed after approval' WHERE id=$1", [draftId])).rejects.toThrow();

    const audit = await pool.query("SELECT action FROM app.audit_event WHERE org_id=$1 AND entity=$2", [reviewer.orgId, draftId]);
    expect(audit.rows).toEqual([{ action: "draft.approved" }]);
  });

  it("enforces four-eyes approval, organisation and clearance scope, and records rejection reasons", async () => {
    const author = user(randomUUID());
    const selfDraft = await insertDraft(author.orgId, author.sub);
    await expect(store.decide({ user: author, draftId: selfDraft, decision: "approve", idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(DraftServiceError);

    const reviewUser = user(randomUUID());
    const restrictedDraft = await insertDraft(reviewUser.orgId, "agent:report-generator on_behalf_of:synthetic-author", "CONFIDENTIAL");
    await expect(store.get(user(reviewUser.sub, "PUBLIC"), restrictedDraft)).rejects.toMatchObject({ code: "forbidden" });
    await expect(store.get(user(randomUUID()), restrictedDraft)).rejects.toMatchObject({ code: "not_found" });
    const rejected = await store.decide({ user: { ...reviewUser, clearance: "CONFIDENTIAL" }, draftId: restrictedDraft,
      decision: "reject", reason: "Needs additional source context", idempotencyKey: randomUUID() });
    expect(rejected).toMatchObject({ status: "rejected", decisionReason: "Needs additional source context", approvedBy: null });
    const audit = await pool.query("SELECT action FROM app.audit_event WHERE org_id=$1 AND entity=$2", [reviewUser.orgId, restrictedDraft]);
    expect(audit.rows).toEqual([{ action: "draft.rejected" }]);
  });
});
