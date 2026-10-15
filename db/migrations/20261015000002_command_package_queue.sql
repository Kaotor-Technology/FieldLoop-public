-- migrate:up
SET search_path = app, public;

ALTER TABLE command_package
    ADD COLUMN barrier_id uuid REFERENCES barrier(id),
    ADD COLUMN procedure_ref text,
    ADD COLUMN execution_status text NOT NULL DEFAULT 'queued'
        CHECK (execution_status IN ('queued', 'executed', 'not_executed')),
    ADD COLUMN recorded_at timestamptz,
    ADD COLUMN outcome_actor text,
    ADD COLUMN outcome_key_hash text CHECK (outcome_key_hash IS NULL OR outcome_key_hash ~ '^[a-f0-9]{64}$'),
    ADD COLUMN outcome_request_hash text CHECK (outcome_request_hash IS NULL OR outcome_request_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE evidence
    ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN command_package_id uuid;

ALTER TABLE command_package
    ADD CONSTRAINT uq_command_package_org_id UNIQUE (org_id, id);
ALTER TABLE evidence
    ADD CONSTRAINT fk_evidence_command_package_org FOREIGN KEY (org_id, command_package_id)
        REFERENCES command_package(org_id, id);
CREATE UNIQUE INDEX uq_command_package_action_request ON command_package (org_id, action_request_id);
CREATE UNIQUE INDEX uq_evidence_command_package ON evidence (org_id, command_package_id)
    WHERE command_package_id IS NOT NULL;

-- Recover any complete field-command proposals created before the queue existed. Incomplete or
-- cross-Organisation legacy records remain unavailable to the operator queue.
INSERT INTO command_package
    (org_id, action_request_id, target, preconditions, simulated, classification, created_by,
     simulation_run_id, barrier_id, procedure_ref, execution_status)
SELECT a.org_id, a.id, a.payload->>'target', a.payload->'preconditions', a.simulated, a.classification,
    a.created_by, a.simulation_run_id, b.id, a.payload->>'procedure', 'queued'
FROM action_request a
JOIN barrier b ON b.org_id = a.org_id AND b.id::text = a.payload->>'barrierId' AND b.simulated = a.simulated
WHERE a.action_type = 'field_command' AND a.action_level = 'l1'
    AND COALESCE(NULLIF(btrim(a.payload->>'target'), ''), '') <> ''
    AND COALESCE(NULLIF(btrim(a.payload->>'action'), ''), '') <> ''
    AND COALESCE(NULLIF(btrim(a.payload->>'procedure'), ''), '') <> ''
    AND COALESCE(NULLIF(btrim(a.payload->>'expectedEffect'), ''), '') <> ''
    AND jsonb_typeof(a.payload->'preconditions') = 'array'
ON CONFLICT (org_id, action_request_id) DO NOTHING;

CREATE FUNCTION sync_command_package_request() RETURNS trigger AS $$
DECLARE
    linked_barrier app.barrier%ROWTYPE;
    existing_package app.command_package%ROWTYPE;
BEGIN
    IF NEW.action_type <> 'field_command' THEN RETURN NEW; END IF;
    IF NEW.action_level <> 'l1'
        OR COALESCE(NULLIF(btrim(NEW.payload->>'target'), ''), '') = ''
        OR COALESCE(NULLIF(btrim(NEW.payload->>'action'), ''), '') = ''
        OR COALESCE(NULLIF(btrim(NEW.payload->>'procedure'), ''), '') = ''
        OR COALESCE(NULLIF(btrim(NEW.payload->>'expectedEffect'), ''), '') = ''
        OR jsonb_typeof(NEW.payload->'preconditions') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Field Command must be a complete L1 Command Package' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO linked_barrier FROM app.barrier b
    WHERE b.org_id = NEW.org_id AND b.id::text = NEW.payload->>'barrierId' AND b.simulated = NEW.simulated
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Command Package Barrier is unavailable in this Organisation and simulation' USING ERRCODE = 'check_violation';
    END IF;
    IF array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], COALESCE(linked_barrier.classification, 'INTERNAL'))
        > array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], NEW.classification) THEN
        RAISE EXCEPTION 'Command Package classification is below its Barrier classification' USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO existing_package FROM app.command_package p
    WHERE p.org_id = NEW.org_id AND p.action_request_id = NEW.id FOR UPDATE;
    IF FOUND THEN
        IF existing_package.execution_status <> 'queued' OR existing_package.outcome IS NOT NULL THEN
            RAISE EXCEPTION 'A recorded Command Package outcome cannot be rebound' USING ERRCODE = 'check_violation';
        END IF;
        UPDATE app.command_package SET target = NEW.payload->>'target',
            preconditions = NEW.payload->'preconditions', barrier_id = linked_barrier.id,
            procedure_ref = NEW.payload->>'procedure'
        WHERE org_id = NEW.org_id AND id = existing_package.id;
    ELSE
        INSERT INTO app.command_package
            (org_id, action_request_id, target, preconditions, simulated, classification, created_by,
             simulation_run_id, barrier_id, procedure_ref, execution_status)
        VALUES (NEW.org_id, NEW.id, NEW.payload->>'target', NEW.payload->'preconditions', NEW.simulated,
            NEW.classification, NEW.created_by, NEW.simulation_run_id, linked_barrier.id,
            NEW.payload->>'procedure', 'queued');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;

CREATE TRIGGER sync_command_package_request
AFTER INSERT OR UPDATE OF payload ON action_request
FOR EACH ROW EXECUTE FUNCTION sync_command_package_request();

CREATE FUNCTION guard_command_package_update() RETURNS trigger AS $$
DECLARE parent app.action_request%ROWTYPE;
BEGIN
    IF (NEW.org_id, NEW.action_request_id, NEW.simulated, NEW.classification, NEW.created_by, NEW.simulation_run_id, NEW.created_at)
        IS DISTINCT FROM (OLD.org_id, OLD.action_request_id, OLD.simulated, OLD.classification, OLD.created_by, OLD.simulation_run_id, OLD.created_at) THEN
        RAISE EXCEPTION 'Command Package identity and simulation scope are immutable' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO parent FROM app.action_request a
    WHERE a.org_id = NEW.org_id AND a.id = NEW.action_request_id FOR SHARE;
    IF NOT FOUND OR parent.action_type <> 'field_command' OR parent.action_level <> 'l1'
        OR NEW.target IS DISTINCT FROM parent.payload->>'target'
        OR NEW.preconditions IS DISTINCT FROM parent.payload->'preconditions'
        OR NEW.procedure_ref IS DISTINCT FROM parent.payload->>'procedure'
        OR NOT EXISTS (SELECT 1 FROM app.barrier b WHERE b.org_id = NEW.org_id AND b.id = NEW.barrier_id
            AND b.id::text = parent.payload->>'barrierId' AND b.simulated = NEW.simulated) THEN
        RAISE EXCEPTION 'Command Package metadata must follow its exact Action Request payload' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.execution_status, NEW.outcome, NEW.executed_by, NEW.recorded_at, NEW.outcome_actor, NEW.outcome_key_hash, NEW.outcome_request_hash)
        IS DISTINCT FROM (OLD.execution_status, OLD.outcome, OLD.executed_by, OLD.recorded_at, OLD.outcome_actor, OLD.outcome_key_hash, OLD.outcome_request_hash) THEN
        IF OLD.execution_status <> 'queued' OR OLD.outcome IS NOT NULL
            OR NEW.execution_status NOT IN ('executed', 'not_executed')
            OR NEW.outcome IS NULL OR btrim(NEW.outcome) = '' OR length(NEW.outcome) > 2000
            OR NEW.executed_by IS NULL OR NEW.outcome_actor IS DISTINCT FROM NEW.executed_by
            OR NEW.recorded_at IS NULL OR NEW.outcome_key_hash IS NULL OR NEW.outcome_request_hash IS NULL
            OR parent.status <> 'approved' OR parent.expires_at <= clock_timestamp() OR parent.simulation_retired_at IS NOT NULL
            OR (SELECT count(DISTINCT ap.approver_sub) FROM app.approval ap WHERE ap.org_id = parent.org_id
                AND ap.action_request_id = parent.id AND ap.decision = 'approved' AND ap.voided_at IS NULL
                AND ap.payload_hash = parent.payload_hash AND ap.approver_sub <> parent.requested_by
                AND ap.approver_sub NOT LIKE 'agent:%' AND ap.simulated = parent.simulated
                AND ap.classification IS NOT DISTINCT FROM parent.classification) < 2 THEN
            RAISE EXCEPTION 'Command Package outcome requires an unexpired approved Action Request and may be recorded once' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;

CREATE TRIGGER guard_command_package_update
BEFORE UPDATE ON command_package
FOR EACH ROW EXECUTE FUNCTION guard_command_package_update();

CREATE FUNCTION guard_command_package_outcome_evidence() RETURNS trigger AS $$
DECLARE package app.command_package%ROWTYPE;
BEGIN
    IF NEW.command_package_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO package FROM app.command_package p
    WHERE p.org_id = NEW.org_id AND p.id = NEW.command_package_id FOR SHARE;
    IF NOT FOUND OR package.barrier_id IS DISTINCT FROM NEW.barrier_id
        OR package.simulated IS DISTINCT FROM NEW.simulated
        OR package.classification IS DISTINCT FROM NEW.classification
        OR package.execution_status IS DISTINCT FROM NEW.details->>'executionStatus'
        OR package.outcome IS DISTINCT FROM NEW.details->>'outcome'
        OR package.outcome_actor IS DISTINCT FROM NEW.created_by
        OR NEW.kind <> 'command_package_outcome' OR NEW.source <> 'control_room' THEN
        RAISE EXCEPTION 'Command Package Evidence scope is invalid' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = app, pg_temp;

CREATE TRIGGER guard_command_package_outcome_evidence
BEFORE INSERT OR UPDATE ON evidence
FOR EACH ROW EXECUTE FUNCTION guard_command_package_outcome_evidence();

REVOKE INSERT, UPDATE, DELETE ON command_package FROM fieldloop_app;
GRANT SELECT ON command_package TO fieldloop_app;
GRANT UPDATE (execution_status, outcome, executed_by, recorded_at, outcome_actor, outcome_key_hash, outcome_request_hash)
    ON command_package TO fieldloop_app;
DO $$
DECLARE environment text; app_role text;
BEGIN
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN RETURN; END IF;
    environment := replace(current_database(), 'fieldloop_', '');
    app_role := 'fieldloop_app_' || environment;
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON app.command_package FROM %I', app_role);
    EXECUTE format('GRANT SELECT ON app.command_package TO %I', app_role);
    EXECUTE format('GRANT UPDATE (execution_status, outcome, executed_by, recorded_at, outcome_actor, outcome_key_hash, outcome_request_hash) ON app.command_package TO %I', app_role);
END $$;

-- migrate:down
DROP TRIGGER guard_command_package_outcome_evidence ON app.evidence;
DROP FUNCTION app.guard_command_package_outcome_evidence();
DROP TRIGGER guard_command_package_update ON app.command_package;
DROP FUNCTION app.guard_command_package_update();
DROP TRIGGER sync_command_package_request ON app.action_request;
DROP FUNCTION app.sync_command_package_request();
DROP INDEX app.uq_evidence_command_package;
DROP INDEX app.uq_command_package_action_request;
ALTER TABLE app.evidence DROP CONSTRAINT fk_evidence_command_package_org;
ALTER TABLE app.command_package DROP CONSTRAINT uq_command_package_org_id;
ALTER TABLE app.evidence DROP COLUMN command_package_id, DROP COLUMN details;
ALTER TABLE app.command_package DROP COLUMN barrier_id, DROP COLUMN procedure_ref, DROP COLUMN execution_status,
    DROP COLUMN recorded_at, DROP COLUMN outcome_actor, DROP COLUMN outcome_key_hash, DROP COLUMN outcome_request_hash;
GRANT INSERT, UPDATE, DELETE ON app.command_package TO fieldloop_app;
DO $$
DECLARE environment text; app_role text;
BEGIN
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN RETURN; END IF;
    environment := replace(current_database(), 'fieldloop_', '');
    app_role := 'fieldloop_app_' || environment;
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON app.command_package TO %I', app_role);
END $$;
