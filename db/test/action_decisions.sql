-- FL-96 database safeguards for Approver decisions on Action Requests.
BEGIN;

CREATE FUNCTION pg_temp.expect_error(statement text, expected_sqlstate text, label text) RETURNS void AS $$
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = expected_sqlstate THEN
            RETURN;
        END IF;
        RAISE EXCEPTION 'expected SQLSTATE % but got % (%): %', expected_sqlstate, SQLSTATE, SQLERRM, label;
    END;
    RAISE EXCEPTION 'expected an error: %', label;
END;
$$ LANGUAGE plpgsql;

INSERT INTO app.action_request (id, org_id, action_type, action_level, target, payload, status, simulated, classification)
VALUES ('96000000-0000-4000-8000-000000000001', 'synthetic-decision-test', 'emergency_communication', 'l2', 'stakeholders',
    '{"message":"SIMULATION drill"}', 'open', true, 'INTERNAL');

-- A decision can be remembered per operation, so a replay by Idempotency-Key is possible.
INSERT INTO app.action_check_result (org_id, actor, operation, key_hash, request_hash, result, action_request_id, simulated, classification)
VALUES ('synthetic-decision-test', 'synthetic-manager', 'approve', repeat('a', 64), repeat('b', 64), '{}',
    '96000000-0000-4000-8000-000000000001', true, 'INTERNAL'),
    ('synthetic-decision-test', 'synthetic-manager', 'reject', repeat('a', 64), repeat('b', 64), '{}',
    '96000000-0000-4000-8000-000000000001', true, 'INTERNAL');

SELECT pg_temp.expect_error(
    $$INSERT INTO app.action_check_result (org_id, actor, operation, key_hash, request_hash, result, simulated, classification)
      VALUES ('synthetic-decision-test', 'synthetic-manager', 'release', repeat('c', 64), repeat('b', 64), '{}', true, 'INTERNAL')$$,
    '23514', 'an unknown decision operation is refused');

-- One Approver cannot decide the same payload twice, so one person cannot count as two Approvers.
INSERT INTO app.approval (org_id, action_request_id, approver_sub, decision, reason, payload_hash, auth_time, simulated, classification)
SELECT org_id, id, 'synthetic-manager', 'approved', 'Reviewed the exact payload', payload_hash, now(), simulated, classification
FROM app.action_request WHERE id = '96000000-0000-4000-8000-000000000001';
SELECT pg_temp.expect_error(
    $$INSERT INTO app.approval (org_id, action_request_id, approver_sub, decision, reason, payload_hash, auth_time, simulated, classification)
      SELECT org_id, id, 'synthetic-manager', 'approved', 'Second decision', payload_hash, now(), simulated, classification
      FROM app.action_request WHERE id = '96000000-0000-4000-8000-000000000001'$$,
    '23505', 'the same Approver cannot decide twice');

ROLLBACK;

-- Runtime role separation in dev/demo: only web-api can record an Approval; no AI-facing role can.
DO $$
DECLARE environment text; web_role text; guardrail_role text; assistant_role text;
BEGIN
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN RETURN; END IF;
    environment := replace(current_database(), 'fieldloop_', '');
    web_role := 'fieldloop_app_' || environment;
    guardrail_role := 'fieldloop_guardrail_' || environment;
    assistant_role := 'fieldloop_assistant_' || environment;
    IF NOT has_table_privilege(web_role, 'app.approval', 'INSERT')
        OR NOT has_table_privilege(web_role, 'app.approval', 'SELECT')
        OR has_table_privilege(web_role, 'app.approval', 'UPDATE')
        OR has_table_privilege(web_role, 'app.approval', 'DELETE')
        OR has_table_privilege(guardrail_role, 'app.approval', 'INSERT')
        OR has_table_privilege(assistant_role, 'app.approval', 'INSERT') THEN
        RAISE EXCEPTION 'Approval privileges differ from the approved scope';
    END IF;
END $$;
