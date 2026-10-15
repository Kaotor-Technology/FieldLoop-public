import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { GoogleModelArmorAdapter } from "../packages/adapters/dist/guardrail-detectors.js";
import { buildApp } from "../apps/guardrail/dist/app.js";
import { PostgresGuardrailStore } from "../apps/guardrail/dist/postgres-store.js";
import { LocalJwksInternalUserTokenVerifier } from "../apps/guardrail/dist/internal-user-token.js";
import { SecretManagerInternalTokenService } from "../apps/api/dist/auth/internal-tokens.js";
import { domainPackRecordId, registerDomainPackRecords } from "../apps/api/dist/domain-packs.js";

/** Real gateway, JWT, regional detector adapter and migrated DB; detector/model transports are fake. */
export async function testGuardrailAcceptance(database, connectionString, packs) {
  const orgId = "fl37-guardrail-acceptance";
  const pack = packs.find(({ content }) => content.id === "gen-ai-safety");
  assert.ok(pack?.aiSafety);
  const seedConnection = new Kysely({ dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString, options: "-c role=fieldloop_app" }),
  }) });
  const runtime = new Kysely({ dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString, options: "-c role=fieldloop_guardrail_test" }),
  }) });
  let app;
  try {
    await registerDomainPackRecords(seedConnection, orgId, [pack]);
    const healthBefore = (await sql`SELECT id, health FROM app.barrier ORDER BY id`.execute(database)).rows;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signer = new SecretManagerInternalTokenService({
      read: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }, "https://synthetic-bff.test", "fieldloop-internal", "fl37-test");
    const token = await signer.sign({ sub: "synthetic-reviewer", roles: ["fieldloop.viewer"],
      clearance: "HIGHLY_RESTRICTED", orgId });
    const userTokenVerifier = new LocalJwksInternalUserTokenVerifier({
      jwks: JSON.stringify(await signer.jwks()), issuer: "https://synthetic-bff.test", audience: "fieldloop-internal",
    });
    const requests = [];
    const modelRequests = [];
    const failures = [];
    let detectorMode = "allow";
    const transport = async (url, init) => {
      assert.match(String(url), /^https:\/\/modelarmor\.asia-southeast1\.rep\.googleapis\.com\//);
      const body = JSON.parse(init.body);
      requests.push(body);
      // Keep a transport handle alive until the adapter's deadline aborts it.
      if (detectorMode === "timeout") return new Promise((_, reject) => {
        const keepAlive = setInterval(() => {}, 1_000);
        init.signal.addEventListener("abort", () => {
          clearInterval(keepAlive);
          reject(init.signal.reason);
        }, { once: true });
      });
      if (detectorMode === "error") return new Response("detector unavailable", { status: 503 });
      if (detectorMode === "invalid") return detectorResponse({});
      const text = body.userPromptData?.text ?? body.modelResponseData?.text;
      if (detectorMode === "injection") {
        assert.match(text, /ignore previous instructions/);
        return detectorResponse({ piAndJailbreakFilterResult: { filterMatchState: "MATCH_FOUND" } }, true);
      }
      if (detectorMode === "restricted" && body.userPromptData) {
        assert.match(text, /SYNTHETIC_SECRET/);
        return detectorResponse({ sdpFilterResult: { deidentifyResult: {
          executionState: "EXECUTION_SUCCESS", matchState: "MATCH_FOUND",
          infoTypes: ["AUTH_TOKEN"], data: { text: "SYNTHETIC account [REDACTED]" },
        } } }, true);
      }
      return detectorResponse({ piAndJailbreakFilterResult: { filterMatchState: "NO_MATCH_FOUND" } });
    };
    app = buildApp({
      orgId, simulated: true, store: new PostgresGuardrailStore(runtime), userTokenVerifier,
      logError: (error) => failures.push(error),
      scanner: new GoogleModelArmorAdapter({ projectId: "synthetic-project", location: "asia-southeast1",
        templateId: "synthetic-tier1", timeoutMs: 10, tokenProvider: { getAccessToken: async () => "synthetic-token" }, transport }),
      model: { complete: async (model, request) => {
        modelRequests.push({ model, request });
        return { id: "synthetic-completion", object: "chat.completion", model,
          choices: [{ index: 0, message: { role: "assistant", content: "SYNTHETIC safe answer" }, finish_reason: "stop" }] };
      } },
      vertexModels: { flash: "synthetic-private-flash", pro: "synthetic-private-pro" },
    });
    const headers = { "x-fieldloop-internal-user-token": token };
    const scan = (content, key, extraHeaders = {}) => app.inject({ method: "POST", url: "/guardrail/v1/content:scan",
      headers: { ...headers, "idempotency-key": key, ...extraHeaders }, payload: { aiSystem: pack.aiSafety.aiSystem.id, content } });
    const decisions = async () => (await sql`SELECT id, policy_id, decision, classification
      FROM app.intercept WHERE org_id = ${orgId} ORDER BY created_at, id`.execute(database)).rows;

    // TDD happy: the gateway sees extracted attachment text, not an invented scanner result.
    // The fake Model Armor transport makes this deterministic; this is not detector-recall evidence.
    const pdfText = await readFile(new URL("../apps/guardrail/test/fixtures/contractor-pdf-extracted.txt", import.meta.url), "utf8");
    detectorMode = "injection";
    const blocked = await scan(pdfText, "fl37-pdf-injection-0001");
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.json().detail, /prompt injection/);
    assert.equal(blocked.json().policyId, blocked.headers["x-fieldloop-policy-id"]);
    assert.equal(blocked.json().error.policy_id, blocked.json().policyId);
    assert.ok(blocked.headers["x-fieldloop-intercept-id"]);
    assert.ok(!blocked.body.includes(pdfText));
    assert.equal(modelRequests.length, 0);
    assert.equal(requests[0].userPromptData.text, pdfText);
    assert.equal((await decisions()).length, 1);
    const replay = await scan(pdfText, "fl37-pdf-injection-0001");
    assert.equal(replay.statusCode, 403);
    assert.equal(replay.headers["x-fieldloop-intercept-id"], blocked.headers["x-fieldloop-intercept-id"]);
    assert.equal(requests.length, 1);
    assert.equal((await decisions()).length, 1);
    assert.equal((await scan("changed text", "fl37-pdf-injection-0001")).statusCode, 409);

    detectorMode = "restricted";
    const restricted = "SYNTHETIC account SYNTHETIC_SECRET";
    const rerouted = await scan(restricted, "fl37-restricted-scan-0001");
    assert.equal(rerouted.statusCode, 200);
    assert.equal(rerouted.json().decision, "reroute");
    assert.equal(rerouted.json().classification, "HIGHLY_RESTRICTED");
    const chat = await app.inject({ method: "POST", url: "/guardrail/v1/chat/completions", headers,
      payload: { aiSystem: pack.aiSafety.aiSystem.id, messages: [{ role: "user", content: restricted }] } });
    assert.equal(chat.statusCode, 200);
    assert.equal(chat.headers["x-fieldloop-classification"], "HIGHLY_RESTRICTED");
    assert.equal(modelRequests.length, 1);
    assert.equal(modelRequests[0].model, "synthetic-private-flash");
    assert.deepEqual(modelRequests[0].request.messages, [{ role: "user", content: "SYNTHETIC account [REDACTED]" }]);
    assert.ok(!(JSON.stringify(modelRequests).includes("SYNTHETIC_SECRET")));

    detectorMode = "allow";
    const thai = "SYNTHETIC สรุปผลการตรวจสอบแนวกั้นและระบุหลักฐานที่ต้องทบทวน";
    const allowed = await scan(thai, "fl37-benign-thai-0001");
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json().content, thai);
    assert.equal(allowed.json().decision, "allow");
    for (const mode of ["timeout", "error", "invalid"]) {
      detectorMode = mode;
      const failed = await scan("SYNTHETIC normal content", `fl37-detector-${mode}-0001`);
      assert.equal(failed.statusCode, 503);
      assert.equal(failed.json().error.code, "guardrail_blocked");
      const expected = { timeout: "timed out", error: "HTTP 503", invalid: "incomplete Tier 1 result" };
      assert.ok(failures.at(-1).message.includes(expected[mode]), `the ${mode} failure must be exercised`);
      assert.ok(failed.headers["x-fieldloop-intercept-id"]);
      assert.equal((await decisions()).at(-1).decision, "block");
      assert.equal(modelRequests.length, 1);
    }

    const recorded = await decisions();
    const evidence = (await sql`SELECT e.id, e.barrier_id, e.classification, e.simulated,
        p.id AS policy_id, p.config->>'bowtieId' AS bowtie_id
      FROM app.evidence e JOIN app.guardrail_policy p ON p.barrier_id = e.barrier_id AND p.org_id = e.org_id
      WHERE e.org_id = ${orgId} AND e.kind = 'guardrail.intercept'`.execute(database)).rows;
    assert.equal(recorded.length, 10);
    assert.equal(evidence.length, recorded.length, "each decision has Bowtie C Evidence");
    const bowtieId = domainPackRecordId(orgId, pack.content.id, "bowtie", pack.aiSafety.bowtie.id);
    assert.ok(evidence.every((row) => row.simulated && row.bowtie_id === bowtieId));
    for (const row of recorded) {
      assert.ok(evidence.some((entry) => entry.policy_id === row.policy_id && entry.classification === row.classification));
    }
    const outbox = (await sql`SELECT event FROM app.signal_event_outbox WHERE org_id = ${orgId}`.execute(database)).rows;
    assert.equal(outbox.length, evidence.length);
    for (const { event } of outbox) {
      assert.equal(event.type, "evidence.created");
      assert.equal(event.simulated, true);
      assert.ok(evidence.some((row) => row.id === event.entityId && row.barrier_id === event.barrierId));
    }
    const stored = (await sql`SELECT to_jsonb(r)::text AS value FROM app.guardrail_content_request r
      WHERE org_id = ${orgId}`.execute(database)).rows;
    assert.equal(stored.length, 6);
    assert.ok(stored.every(({ value }) => !value.includes(pdfText) && !value.includes("SYNTHETIC_SECRET") && !value.includes(token)));
    assert.deepEqual((await sql`SELECT id, health FROM app.barrier ORDER BY id`.execute(database)).rows, healthBefore);
    assert.equal((await sql`SELECT count(*)::int AS count FROM app.health_proposal WHERE org_id = ${orgId}`.execute(database)).rows[0].count, 0);
    const requestCount = requests.length;
    const unauthenticated = await scan(thai, "fl37-invalid-token-0001", {
      "x-fieldloop-internal-user-token": "synthetic-invalid-token",
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(requests.length, requestCount, "unverified caller must never reach the detector");
    // Force a later Evidence write to fail after the Intercept insert; the entire transaction rolls back.
    await sql`ALTER TABLE app.evidence ADD CONSTRAINT fl37_evidence_failure
      CHECK (org_id <> 'fl37-guardrail-acceptance') NOT VALID`.execute(database);
    try {
      detectorMode = "allow";
      const failedWrite = await scan(thai, "fl37-evidence-rollback-0001");
      assert.equal(failedWrite.statusCode, 503);
      assert.equal(failedWrite.json().error.code, "guardrail_unavailable");
      assert.deepEqual(await decisions(), recorded, "failed Evidence cannot leave an orphan Intercept");
      assert.equal((await sql`SELECT count(*)::int AS count FROM app.signal_event_outbox
        WHERE org_id = ${orgId}`.execute(database)).rows[0].count, outbox.length);
      assert.equal((await sql`SELECT count(*)::int AS count FROM app.guardrail_content_request
        WHERE org_id = ${orgId}`.execute(database)).rows[0].count, stored.length);
    } finally {
      await sql`ALTER TABLE app.evidence DROP CONSTRAINT fl37_evidence_failure`.execute(database);
    }
    console.log("FL-37 Guardrail acceptance passed: attachment injection notice, private reroute/redaction, Thai content, detector timeout/error, JWT, replay, Intercept/Evidence/outbox and unchanged Health. Detector/model transports are fake; no live latency claim.");
  } finally {
    await app?.close();
    await runtime.destroy();
    await seedConnection.destroy();
  }
}

function detectorResponse(filterResults, matched = false) {
  return new Response(JSON.stringify({ sanitizationResult: {
    invocationResult: "SUCCESS", filterMatchState: matched ? "MATCH_FOUND" : "NO_MATCH_FOUND", filterResults,
  } }), { status: 200 });
}
