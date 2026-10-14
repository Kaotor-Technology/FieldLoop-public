-- FL-87 database safeguards, including runtime role separation in dev/demo.
BEGIN;
INSERT INTO app.action_request (id, org_id, action_type, action_level, target, payload, status, simulated, classification)
VALUES ('87000000-0000-4000-8000-000000000001', 'synthetic-action-test', 'system_of_record', 'l1', 'cmms', '{}', 'open', true, 'INTERNAL');
DO $$
BEGIN
    IF (SELECT expires_at IS NULL OR expires_at <= clock_timestamp() FROM app.action_request WHERE id='87000000-0000-4000-8000-000000000001') THEN
        RAISE EXCEPTION 'Action Request must receive a bounded default SLA';
    END IF;
    BEGIN
        UPDATE app.action_request SET expires_at=expires_at+interval '1 hour' WHERE id='87000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'Action SLA was extended';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE app.action_request SET target='gis' WHERE id='87000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'Action target was rebound without invalidating its payload hash';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE app.action_request SET expires_at=clock_timestamp()-interval '1 second'  WHERE id='87000000-0000-4000-8000-000000000001';
    BEGIN
        UPDATE app.action_request SET status='executed' WHERE id='87000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'Expired action could execute';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO app.action_ceiling(org_id, action_type, action_level, simulated, classification)
        VALUES ('synthetic-action-test', 'system_of_record', 'l2', true, 'INTERNAL');
        RAISE EXCEPTION 'Organisation raised a platform ceiling';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;

-- PRD AX-1: the requester kind is recorded, scoped to the request's AI System and immutable.
INSERT INTO app.ai_system (id, org_id, name, simulated, classification) VALUES
    ('87000000-0000-4000-8000-0000000000a1', 'synthetic-action-test', 'Synthetic AI', true, 'INTERNAL'),
    ('87000000-0000-4000-8000-0000000000a2', 'synthetic-other-org', 'Synthetic other AI', true, 'INTERNAL');
INSERT INTO app.action_request (id, org_id, action_type, action_level, target, payload, status, simulated, classification,
    requester_kind, requester_ai_system_id)
VALUES ('87000000-0000-4000-8000-000000000002', 'synthetic-action-test', 'system_of_record', 'l1', 'cmms', '{}', 'open', true, 'INTERNAL',
    'assistant', '87000000-0000-4000-8000-0000000000a1');
DO $$
DECLARE scope_case record;
BEGIN
    IF (SELECT requester_kind FROM app.action_request WHERE id='87000000-0000-4000-8000-000000000001') <> 'person' THEN
        RAISE EXCEPTION 'Action Request without an AI System must default to a person requester';
    END IF;
    FOR scope_case IN SELECT * FROM (VALUES
        ('assistant', NULL::uuid), ('person', '87000000-0000-4000-8000-0000000000a1'::uuid),
        ('assistant', '87000000-0000-4000-8000-0000000000a2'::uuid), ('signal_rule', NULL::uuid)) AS c(kind, ai_system_id)
    LOOP
        BEGIN
            INSERT INTO app.action_request (org_id, action_type, action_level, target, payload, status, simulated, classification,
                requester_kind, requester_ai_system_id)
            VALUES ('synthetic-action-test', 'system_of_record', 'l1', 'cmms', '{}', 'open', true, 'INTERNAL',
                scope_case.kind, scope_case.ai_system_id);
            RAISE EXCEPTION 'Invalid requester % / % was accepted', scope_case.kind, scope_case.ai_system_id;
        EXCEPTION WHEN check_violation THEN NULL;
        END;
    END LOOP;
    BEGIN
        UPDATE app.action_request SET requester_kind='person', requester_ai_system_id=NULL
        WHERE id='87000000-0000-4000-8000-000000000002';
        RAISE EXCEPTION 'Action requester was rebound without invalidating its payload hash';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;
ROLLBACK;

DO $$
DECLARE environment text; guardrail_role text; worker_role text;
BEGIN
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN RETURN; END IF;
    environment := replace(current_database(), 'fieldloop_', '');
    guardrail_role := 'fieldloop_guardrail_' || environment;
    worker_role := 'fl-v2-signal-worker-' || environment || '@example-project.iam';
    IF NOT has_table_privilege(guardrail_role, 'app.action_request', 'INSERT')
        OR NOT has_table_privilege(guardrail_role, 'app.held_request', 'INSERT')
        OR NOT has_table_privilege(guardrail_role, 'app.action_check_result', 'INSERT')
        OR NOT has_table_privilege(guardrail_role, 'app.audit_event', 'INSERT')
        OR has_table_privilege(guardrail_role, 'app.approval', 'INSERT')
        OR has_table_privilege(guardrail_role, 'app.audit_event', 'UPDATE')
        OR has_table_privilege(guardrail_role, 'app.action_ceiling', 'UPDATE') THEN
        RAISE EXCEPTION 'Guardrail proposal privileges differ from the approved scope';
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=worker_role) AND (
        NOT has_column_privilege(worker_role, 'app.action_request', 'status', 'UPDATE')
        OR NOT has_table_privilege(worker_role, 'app.action_escalation', 'INSERT')
        OR has_table_privilege(worker_role, 'app.action_request', 'INSERT')
        OR has_column_privilege(worker_role, 'app.action_request', 'payload', 'UPDATE')
        OR has_table_privilege(worker_role, 'app.approval', 'INSERT')) THEN
        RAISE EXCEPTION 'Expiry worker has incorrect action privileges';
    END IF;
END $$;
