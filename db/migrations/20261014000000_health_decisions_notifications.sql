-- migrate:up
SET search_path = app, public;

ALTER TABLE health_proposal
    ADD COLUMN decision_key text,
    ADD COLUMN decision_hash text,
    ADD COLUMN decision_response jsonb,
    ADD CONSTRAINT health_proposal_decision_digest CHECK (
        (decision_key IS NULL OR decision_key ~ '^[0-9a-f]{64}$')
        AND (decision_hash IS NULL OR decision_hash ~ '^[0-9a-f]{64}$')
        AND ((decision_key IS NULL) = (decision_hash IS NULL))
        AND ((decision_key IS NULL) = (decision_response IS NULL))
    );
CREATE UNIQUE INDEX uq_health_proposal_decision_key
    ON health_proposal (org_id, decided_by, decision_key) WHERE decision_key IS NOT NULL;

ALTER TABLE notification
    ALTER COLUMN action_request_id DROP NOT NULL,
    ADD COLUMN health_change_id uuid REFERENCES health_change(id),
    ADD COLUMN evidence_id uuid REFERENCES evidence(id),
    ADD CONSTRAINT notification_one_subject CHECK (
        num_nonnulls(action_request_id, health_change_id, evidence_id) = 1
    );
CREATE UNIQUE INDEX uq_notification_health_change_recipient
    ON notification (org_id, health_change_id, recipient_ref)
    WHERE channel = 'in_app' AND health_change_id IS NOT NULL;
CREATE UNIQUE INDEX uq_notification_evidence_recipient
    ON notification (org_id, evidence_id, recipient_ref)
    WHERE channel = 'in_app' AND evidence_id IS NOT NULL;

DROP TRIGGER zz_guard_simulation_action_child ON notification;
CREATE FUNCTION guard_simulation_notification_parent() RETURNS trigger AS $$
DECLARE
    parent_org text;
    parent_simulated boolean;
    parent_run_id uuid;
    parent_retired_at timestamptz;
BEGIN
    IF current_setting('app.simulation_reset', true) = 'on' THEN
        IF current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'app.simulation_workspace'::regclass)) THEN
            RETURN NEW;
        END IF;
    END IF;

    IF NEW.action_request_id IS NOT NULL THEN
        SELECT org_id, simulated, simulation_run_id, simulation_retired_at
        INTO STRICT parent_org, parent_simulated, parent_run_id, parent_retired_at
        FROM app.action_request WHERE id = NEW.action_request_id FOR SHARE;
    ELSIF NEW.health_change_id IS NOT NULL THEN
        SELECT org_id, simulated, simulation_run_id, simulation_retired_at
        INTO STRICT parent_org, parent_simulated, parent_run_id, parent_retired_at
        FROM app.health_change WHERE id = NEW.health_change_id;
    ELSIF NEW.evidence_id IS NOT NULL THEN
        SELECT org_id, simulated, simulation_run_id, simulation_retired_at
        INTO STRICT parent_org, parent_simulated, parent_run_id, parent_retired_at
        FROM app.evidence WHERE id = NEW.evidence_id;
    ELSE
        RAISE EXCEPTION 'Notification must reference one supported subject' USING ERRCODE = 'check_violation';
    END IF;

    IF parent_org <> NEW.org_id OR parent_simulated <> NEW.simulated OR parent_retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'Notification subject scope is invalid or retired' USING ERRCODE = 'check_violation';
    END IF;
    IF parent_run_id IS NOT NULL THEN
        PERFORM app.assert_simulation_run(parent_run_id, parent_org);
        IF NEW.simulation_run_id IS DISTINCT FROM parent_run_id THEN
            RAISE EXCEPTION 'Notification belongs to another SimulationRun' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = app, pg_temp;
CREATE TRIGGER zz_guard_simulation_notification_parent BEFORE INSERT OR UPDATE ON notification
FOR EACH ROW EXECUTE FUNCTION guard_simulation_notification_parent();

DO $$
DECLARE worker_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        worker_role := 'fl-v2-signal-worker-' || replace(current_database(), 'fieldloop_', '') || '@example-project.iam';
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
            EXECUTE format('GRANT SELECT (id), INSERT ON app.notification TO %I', worker_role);
        END IF;
    END IF;
END $$;

-- migrate:down
SET search_path = app, public;
DROP TRIGGER zz_guard_simulation_notification_parent ON notification;
DROP FUNCTION guard_simulation_notification_parent();
DELETE FROM notification WHERE health_change_id IS NOT NULL OR evidence_id IS NOT NULL;
DO $$
DECLARE worker_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        worker_role := 'fl-v2-signal-worker-' || replace(current_database(), 'fieldloop_', '') || '@example-project.iam';
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = worker_role) THEN
            EXECUTE format('REVOKE SELECT (id), INSERT ON app.notification FROM %I', worker_role);
        END IF;
    END IF;
END $$;
CREATE TRIGGER zz_guard_simulation_action_child BEFORE INSERT OR UPDATE ON notification
FOR EACH ROW EXECUTE FUNCTION guard_simulation_action_child();
DROP INDEX uq_notification_evidence_recipient;
DROP INDEX uq_notification_health_change_recipient;
ALTER TABLE notification DROP CONSTRAINT notification_one_subject;
ALTER TABLE notification DROP COLUMN evidence_id, DROP COLUMN health_change_id;
ALTER TABLE notification ALTER COLUMN action_request_id SET NOT NULL;
DROP INDEX uq_health_proposal_decision_key;
ALTER TABLE health_proposal DROP CONSTRAINT health_proposal_decision_digest,
    DROP COLUMN decision_response, DROP COLUMN decision_hash, DROP COLUMN decision_key;
