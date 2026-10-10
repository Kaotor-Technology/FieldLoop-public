-- Regression tests for exact-payload approvals (PRD AX-2, FL-60).
-- Runs with the default search_path on purpose: the triggers must not depend on the caller's.
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

CREATE FUNCTION pg_temp.expect(condition boolean, label text) RETURNS void AS $$
BEGIN
    IF condition IS NOT TRUE THEN
        RAISE EXCEPTION 'assertion failed: %', label;
    END IF;
END;
$$ LANGUAGE plpgsql;

INSERT INTO app.action_request (id, org_id, action_type, action_level, payload, status, simulated)
VALUES ('00000000-0000-0000-0000-000000000001', 'org-test', 'public_warning', 'l1', '{"message": "a"}', 'open', true);

SELECT pg_temp.expect(
    payload_hash = encode(sha256(convert_to(payload::text, 'UTF8')), 'hex'),
    'payload_hash is derived from the payload')
FROM app.action_request;

SELECT pg_temp.expect_error(
    $$INSERT INTO app.action_request (org_id, action_type, action_level, payload, payload_hash, status)
      VALUES ('org-test', 'public_warning', 'l1', '{}', 'forged', 'open')$$,
    '428C9', 'payload_hash cannot be supplied on insert');
SELECT pg_temp.expect_error(
    $$UPDATE app.action_request SET payload_hash = 'forged'$$,
    '428C9', 'payload_hash cannot be changed on its own');

SELECT pg_temp.expect_error(
    $$INSERT INTO app.approval (org_id, action_request_id, approver_sub, decision, payload_hash, auth_time)
      VALUES ('org-test', '00000000-0000-0000-0000-000000000001', 'approver-1', 'approved', 'wrong', now())$$,
    '23514', 'approval with a wrong hash is rejected');

SELECT pg_temp.expect_error(
    $$INSERT INTO app.action_request (org_id, action_type, action_level, payload, status)
      VALUES ('org-test', 'public_warning', 'l1', '{}', 'approved')$$,
    '23514', 'a request cannot be created already approved');
SELECT pg_temp.expect_error(
    $$UPDATE app.action_request SET status = 'approved'$$,
    '23514', 'a request cannot be approved without an approval');

INSERT INTO app.approval (org_id, action_request_id, approver_sub, decision, reason, payload_hash, auth_time, simulated)
SELECT 'org-test', id, 'approver-0', 'rejected', 'not yet', payload_hash, now(), true
FROM app.action_request;
SELECT pg_temp.expect_error(
    $$UPDATE app.action_request SET status = 'approved'$$,
    '23514', 'a rejection does not allow approved');

INSERT INTO app.approval (id, org_id, action_request_id, approver_sub, decision, payload_hash, auth_time, simulated)
SELECT '00000000-0000-0000-0000-00000000000a', 'org-test', id, 'approver-1', 'approved', payload_hash, now(), true
FROM app.action_request;
UPDATE app.action_request SET status = 'approved';

SELECT pg_temp.expect_error(
    $$UPDATE app.approval SET decision = 'rejected'$$,
    '23514', 'approval cannot be edited');
SELECT pg_temp.expect_error(
    $$DELETE FROM app.approval$$,
    '23514', 'approval cannot be deleted');
SELECT pg_temp.expect_error(
    $$TRUNCATE app.approval$$,
    '23514', 'approval cannot be truncated');

-- A status-only update keeps the Approval.
SELECT pg_temp.expect(status = 'approved', 'status-only update keeps approved') FROM app.action_request;
SELECT pg_temp.expect(bool_and(voided_at IS NULL), 'approvals still valid before a payload change') FROM app.approval;

-- Changing the payload, even together with status, reopens the request and voids the Approval.
CREATE TEMP TABLE old_hash AS SELECT payload_hash FROM app.action_request;
UPDATE app.action_request SET payload = '{"message": "b"}', status = 'approved';
SELECT pg_temp.expect(status = 'open', 'payload change resets status to open') FROM app.action_request;
SELECT pg_temp.expect(
    a.payload_hash <> o.payload_hash, 'payload change changes the hash')
FROM app.action_request a, old_hash o;
SELECT pg_temp.expect(bool_and(voided_at IS NOT NULL), 'payload change voids every approval') FROM app.approval;

SELECT pg_temp.expect_error(
    $$INSERT INTO app.approval (org_id, action_request_id, approver_sub, decision, payload_hash, auth_time)
      SELECT 'org-test', '00000000-0000-0000-0000-000000000001', 'approver-2', 'approved', payload_hash, now()
      FROM old_hash$$,
    '23514', 'the old hash can no longer approve the changed payload');

-- Changing the payload back does not revive the voided Approval.
UPDATE app.action_request SET payload = '{"message": "a"}';
SELECT pg_temp.expect(
    a.payload_hash = o.payload_hash, 'same payload gives the same hash')
FROM app.action_request a, old_hash o;
SELECT pg_temp.expect(count(*) = 0, 'no valid approval after reverting the payload')
FROM app.approval WHERE voided_at IS NULL;
SELECT pg_temp.expect_error(
    $$UPDATE app.approval SET voided_at = NULL$$,
    '23514', 'a voided approval cannot be revived');
SELECT pg_temp.expect_error(
    $$UPDATE app.action_request SET status = 'approved'$$,
    '23514', 'a voided approval does not allow approved');

-- The app role needs no UPDATE on approval: a payload change by it still voids the Approvals.
INSERT INTO app.approval (org_id, action_request_id, approver_sub, decision, payload_hash, auth_time, simulated)
SELECT 'org-test', id, 'approver-3', 'approved', payload_hash, now(), true
FROM app.action_request;
GRANT SELECT, INSERT, UPDATE ON app.action_request TO fieldloop_app;
GRANT SELECT, INSERT ON app.approval TO fieldloop_app;
SET LOCAL ROLE fieldloop_app;
SELECT pg_temp.expect_error(
    $$UPDATE app.approval SET voided_at = now()$$,
    '42501', 'the app role cannot void approvals directly');
UPDATE app.action_request SET payload = '{"message": "c"}';
SELECT pg_temp.expect(count(*) = 0, 'payload change by the app role voids approvals')
FROM app.approval WHERE voided_at IS NULL;
RESET ROLE;

ROLLBACK;
