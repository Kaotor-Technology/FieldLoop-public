-- Regression tests for append-only audit_event (PRD section 10 Audit, FL-60).
BEGIN;

INSERT INTO app.audit_event (org_id, actor, action, entity) VALUES ('org-test', 'tester', 'test', 'none');

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

ROLLBACK;
