-- Regression tests for append-only audit_event (PRD section 10 Audit, FL-60) and the shared
-- append protocol app.append_audit_event (FL-91).
BEGIN;

SELECT * FROM app.append_audit_event('org-test', 'tester', 'test', 'none', NULL, NULL, true, 'INTERNAL');

-- Triggers reject changes for every role, including the owner.
DO $$
DECLARE
    statement text;
BEGIN
    FOREACH statement IN ARRAY ARRAY[
        $sql$UPDATE app.audit_event SET actor = 'other'$sql$,
        'DELETE FROM app.audit_event',
        'TRUNCATE app.audit_event'
    ] LOOP
        BEGIN
            EXECUTE statement;
        EXCEPTION WHEN check_violation THEN
            CONTINUE;
        END;
        RAISE EXCEPTION 'expected audit_event to reject: %', statement;
    END LOOP;
END $$;

-- The app role appends through the function, can read, and has no privilege to change or remove.
SET LOCAL ROLE fieldloop_app;
SELECT * FROM app.append_audit_event('org-test', 'app', 'test', 'none', NULL, NULL, true, 'INTERNAL');
DO $$
DECLARE
    statement text;
BEGIN
    IF (SELECT count(*) FROM app.audit_event) <> 2 THEN
        RAISE EXCEPTION 'the app role must be able to read audit_event';
    END IF;
    FOREACH statement IN ARRAY ARRAY[
        $sql$UPDATE app.audit_event SET actor = 'other'$sql$,
        'DELETE FROM app.audit_event',
        'TRUNCATE app.audit_event'
    ] LOOP
        BEGIN
            EXECUTE statement;
        EXCEPTION WHEN insufficient_privilege THEN
            CONTINUE;
        END;
        RAISE EXCEPTION 'expected the app role to be denied: %', statement;
    END LOOP;
    -- A direct INSERT bypasses the Organisation lock and the chain: the guard trigger refuses it.
    BEGIN
        INSERT INTO app.audit_event (org_id, actor, action, entity, simulated, classification)
        VALUES ('org-test', 'app', 'test', 'none', true, 'INTERNAL');
    EXCEPTION WHEN insufficient_privilege THEN
        RETURN;
    END;
    RAISE EXCEPTION 'expected a direct INSERT by the app role to be rejected';
END $$;
RESET ROLE;

-- The chain: each row's prev_hash is the hash of the Organisation's previous row, and the
-- hash does not depend on the session time zone.
SET LOCAL TIME ZONE 'Asia/Bangkok';
SELECT * FROM app.append_audit_event('org-test', 'tester', 'test.third', 'none', repeat('a', 64), repeat('b', 64), true, 'INTERNAL', 'creator');
SELECT * FROM app.append_audit_event('org-other', 'tester', 'test', 'none', NULL, NULL, false, 'PUBLIC');
DO $$
DECLARE
    bangkok text;
    utc text;
BEGIN
    IF (SELECT count(*) FROM app.audit_event WHERE org_id = 'org-test' AND prev_hash IS NULL) <> 1
        OR (SELECT count(*) FROM app.audit_event WHERE org_id = 'org-other' AND prev_hash IS NULL) <> 1 THEN
        RAISE EXCEPTION 'each Organisation chain starts with exactly one row without prev_hash';
    END IF;
    IF EXISTS (
        SELECT 1 FROM app.audit_event AS event
        JOIN LATERAL (
            SELECT p FROM app.audit_event AS p WHERE p.org_id = event.org_id AND (p.created_at, p.id) < (event.created_at, event.id)
            ORDER BY p.created_at DESC, p.id DESC LIMIT 1
        ) AS predecessor(p) ON true
        WHERE event.prev_hash IS DISTINCT FROM app.audit_event_hash(predecessor.p)
    ) OR EXISTS (
        SELECT 1 FROM app.audit_event AS event
        WHERE event.prev_hash IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM app.audit_event AS p WHERE p.org_id = event.org_id AND app.audit_event_hash(p) = event.prev_hash)
    ) THEN
        RAISE EXCEPTION 'prev_hash must equal the hash of the previous row in the same Organisation';
    END IF;
    IF (SELECT created_by FROM app.audit_event WHERE action = 'test.third') <> 'creator'
        OR (SELECT created_by FROM app.audit_event WHERE org_id = 'org-other') <> 'tester' THEN
        RAISE EXCEPTION 'created_by defaults to the actor';
    END IF;
    SELECT app.audit_event_hash(e) INTO bangkok FROM app.audit_event AS e WHERE e.action = 'test.third';
    SET LOCAL TIME ZONE 'UTC';
    SELECT app.audit_event_hash(e) INTO utc FROM app.audit_event AS e WHERE e.action = 'test.third';
    IF bangkok IS DISTINCT FROM utc THEN
        RAISE EXCEPTION 'the row hash must not depend on the session time zone';
    END IF;
END $$;

-- Invalid metadata is rejected before anything is written.
DO $$
DECLARE
    args jsonb;
BEGIN
    FOR args IN SELECT value FROM jsonb_array_elements($json$[
        ["", "a", "x", "e", null, null, true, "INTERNAL"],
        ["o", "", "x", "e", null, null, true, "INTERNAL"],
        ["o", "a", " ", "e", null, null, true, "INTERNAL"],
        ["o", "a", "x", "", null, null, true, "INTERNAL"],
        ["o", "a", "x", "e", "raw text", null, true, "INTERNAL"],
        ["o", "a", "x", "e", null, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", true, "INTERNAL"],
        ["o", "a", "x", "e", null, null, null, "INTERNAL"],
        ["o", "a", "x", "e", null, null, true, "UNKNOWN"],
        ["o", "a", "x", "e", null, null, true, null]
    ]$json$::jsonb) LOOP
        BEGIN
            PERFORM app.append_audit_event(args->>0, args->>1, args->>2, args->>3, args->>4, args->>5,
                (args->>6)::boolean, args->>7);
        EXCEPTION WHEN invalid_parameter_value THEN
            CONTINUE;
        END;
        RAISE EXCEPTION 'expected invalid audit metadata to be rejected: %', args;
    END LOOP;
    IF EXISTS (SELECT 1 FROM app.audit_event WHERE org_id = 'o') THEN
        RAISE EXCEPTION 'rejected metadata must not write a row';
    END IF;
END $$;

ROLLBACK;

-- The predecessor read after the lock needs a fresh snapshot, so other isolation levels are refused.
BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $$
BEGIN
    BEGIN
        PERFORM app.append_audit_event('org-test', 'tester', 'test', 'none', NULL, NULL, true, 'INTERNAL');
    EXCEPTION WHEN invalid_transaction_state THEN
        RETURN;
    END;
    RAISE EXCEPTION 'expected a REPEATABLE READ append to be rejected';
END $$;
ROLLBACK;
