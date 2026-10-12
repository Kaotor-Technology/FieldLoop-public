-- Regression tests for append-only audit_event (PRD section 10 Audit, FL-60).
BEGIN;

INSERT INTO app.audit_event (org_id, actor, action, entity, simulated, classification) VALUES ('org-test', 'tester', 'test', 'none', true, 'INTERNAL');

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

-- The app role can append and read, and has no privilege to change or remove.
SET LOCAL ROLE fieldloop_app;
INSERT INTO app.audit_event (org_id, actor, action, entity, simulated, classification) VALUES ('org-test', 'app', 'test', 'none', true, 'INTERNAL');
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
END $$;
RESET ROLE;

ROLLBACK;
