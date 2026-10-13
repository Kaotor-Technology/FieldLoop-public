BEGIN;
SET search_path = app, public;
INSERT INTO asset(id, org_id, type, simulated, classification) VALUES ('11111111-1111-4111-8111-111111111111', 'simulation-test', 'linear', true, 'INTERNAL');
INSERT INTO bowtie(id, org_id, hazard, top_event, simulated, classification) VALUES ('11111111-1111-4111-8111-111111111112', 'simulation-test', 'SIMULATION', 'test event', true, 'INTERNAL');
INSERT INTO barrier(id, org_id, type, side, health, simulated, classification) VALUES
('11111111-1111-4111-8111-111111111113', 'simulation-test', 'test', 'preventive', 'healthy', true, 'INTERNAL'),
('11111111-1111-4111-8111-111111111114', 'another-org', 'test', 'preventive', 'healthy', true, 'INTERNAL'),
('11111111-1111-4111-8111-111111111115', 'simulation-test', 'test', 'preventive', 'healthy', false, 'INTERNAL');
INSERT INTO risk_snapshot(id, org_id, bowtie_id, top_event_freq, simulated, classification) VALUES ('11111111-1111-4111-8111-111111111116', 'simulation-test', '11111111-1111-4111-8111-111111111112', 0.01, true, 'INTERNAL');
INSERT INTO scenario(id, org_id, file, simulated, classification) VALUES ('11111111-1111-4111-8111-111111111117', 'simulation-test', 'test.json', true, 'INTERNAL');
INSERT INTO simulation_run(id, org_id, scenario_id, state, simulated, classification) VALUES ('11111111-1111-4111-8111-111111111118', 'simulation-test', '11111111-1111-4111-8111-111111111117', 'paused', true, 'INTERNAL');
SET LOCAL ROLE fieldloop_app;
SELECT capture_simulation_baseline('simulation-test');
UPDATE simulation_workspace SET active_run_id='11111111-1111-4111-8111-111111111118' WHERE org_id='simulation-test';
SELECT set_config('app.simulation_run_id', '11111111-1111-4111-8111-111111111118', true);
UPDATE barrier SET health='failed' WHERE id IN ('11111111-1111-4111-8111-111111111113', '11111111-1111-4111-8111-111111111115');
INSERT INTO risk_snapshot(org_id, bowtie_id, top_event_freq, simulated, classification) VALUES ('simulation-test', '11111111-1111-4111-8111-111111111112', 0.99, true, 'INTERNAL');
INSERT INTO action_request(id, org_id, action_type, action_level, payload, status, simulated, classification) VALUES ('11111111-1111-4111-8111-111111111119', 'simulation-test', 'test', 'l2', '{}', 'open', true, 'INTERNAL');
INSERT INTO approval(org_id, action_request_id, approver_sub, decision, payload_hash, auth_time, simulated, classification)
SELECT org_id, id, 'synthetic-human', 'approved', payload_hash, now(), simulated, classification FROM action_request WHERE id='11111111-1111-4111-8111-111111111119';
INSERT INTO notification(org_id, action_request_id, channel, recipient_ref, status, sandbox, simulated, classification) VALUES ('simulation-test', '11111111-1111-4111-8111-111111111119', 'email', 'sandbox:test', 'queued', true, true, 'INTERNAL');
INSERT INTO audit_event(org_id, actor, action, entity, simulated, classification) VALUES ('simulation-test', 'synthetic-human', 'approval.created', 'test', true, 'INTERNAL');
SELECT restore_simulation_baseline('simulation-test');
DO $$
BEGIN
    IF (SELECT health FROM barrier WHERE id='11111111-1111-4111-8111-111111111113') <> 'healthy'
        OR (SELECT health FROM barrier WHERE id='11111111-1111-4111-8111-111111111115') <> 'failed'
        OR (SELECT health FROM barrier WHERE id='11111111-1111-4111-8111-111111111114') <> 'healthy' THEN
        RAISE EXCEPTION 'reset crossed Organisation or simulation scope, or did not restore Health';
    END IF;
    IF (SELECT count(*) FROM current_risk_snapshot WHERE org_id='simulation-test') <> 1
        OR (SELECT top_event_freq FROM current_risk_snapshot WHERE org_id='simulation-test') <> 0.01
        OR EXISTS (SELECT 1 FROM current_action_request WHERE org_id='simulation-test')
        OR EXISTS (SELECT 1 FROM current_notification WHERE org_id='simulation-test') THEN
        RAISE EXCEPTION 'reset did not restore the initial active Risk/Action/notification state';
    END IF;
    IF (SELECT count(*) FROM approval WHERE org_id='simulation-test') <> 1
        OR (SELECT count(*) FROM audit_event WHERE org_id='simulation-test') <> 2 THEN
        RAISE EXCEPTION 'reset removed immutable human/audit history';
    END IF;
    BEGIN
        PERFORM assert_simulation_run('11111111-1111-4111-8111-111111111118', 'simulation-test');
        RAISE EXCEPTION 'retired run accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO signal(org_id, source, tag, value, observed_at, simulated, classification)
        VALUES ('simulation-test', 'mock-test', 'test', 1, now(), true, 'INTERNAL');
        RAISE EXCEPTION 'delayed old-run Signal accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE action_request SET simulation_retired_at = NULL WHERE org_id='simulation-test';
        RAISE EXCEPTION 'retired ActionRequest resurrected';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;
-- A new run admits new Signals while refusing stale ones and cross-Organisation writes.
INSERT INTO simulation_run(id, org_id, scenario_id, state, simulated, classification) VALUES ('11111111-1111-4111-8111-111111111120', 'simulation-test', '11111111-1111-4111-8111-111111111117', 'ready', true, 'INTERNAL');
UPDATE simulation_workspace SET active_run_id='11111111-1111-4111-8111-111111111120' WHERE org_id='simulation-test';
SELECT set_config('app.simulation_run_id', '11111111-1111-4111-8111-111111111120', true);
INSERT INTO signal(org_id, source, tag, value, observed_at, simulated, classification) VALUES ('simulation-test', 'mock-test', 'test', 1, now(), true, 'INTERNAL');
DO $$
BEGIN
    BEGIN
        PERFORM assert_simulation_run('11111111-1111-4111-8111-111111111120', 'another-org');
        RAISE EXCEPTION 'cross-Organisation run accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO notification(org_id, action_request_id, channel, recipient_ref, status, sandbox, simulated, classification) VALUES ('simulation-test', '11111111-1111-4111-8111-111111111119', 'email', 'sandbox:test', 'queued', false, true, 'INTERNAL');
        RAISE EXCEPTION 'simulated notification escaped sandbox';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;
DO $$
BEGIN
    BEGIN
        INSERT INTO notification(org_id, action_request_id, channel, recipient_ref, status, sandbox, simulated, classification) VALUES ('simulation-test', '11111111-1111-4111-8111-111111111119', 'email', 'sandbox:test', 'queued', true, true, 'INTERNAL');
        RAISE EXCEPTION 'a queued old ActionRequest produced a new-run notification';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO notification(org_id, action_request_id, channel, recipient_ref, status, sandbox, simulated, classification) VALUES ('simulation-test', '11111111-1111-4111-8111-111111111119', 'email', 'sandbox:test', 'queued', false, false, 'INTERNAL');
        RAISE EXCEPTION 'a simulated ActionRequest was relabelled as a real notification';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;
-- A rollback restores the old epoch as well as all domain state.
SAVEPOINT before_reset;
SELECT restore_simulation_baseline('simulation-test');
ROLLBACK TO SAVEPOINT before_reset;
SELECT assert_simulation_run('11111111-1111-4111-8111-111111111120', 'simulation-test');
ROLLBACK;
