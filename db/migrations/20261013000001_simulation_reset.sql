-- migrate:up
SET search_path = app, public;
ALTER TABLE simulation_run ADD COLUMN player_state jsonb;
CREATE TABLE simulation_workspace (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL UNIQUE,
    active_run_id uuid REFERENCES simulation_run(id),
    baseline jsonb NOT NULL,
    simulated boolean NOT NULL CHECK (simulated),
    classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE simulation_command (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    command_key text NOT NULL,
    body_hash text NOT NULL,
    response jsonb NOT NULL,
    simulated boolean NOT NULL CHECK (simulated),
    classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, command_key)
);
GRANT SELECT, INSERT, UPDATE ON simulation_workspace TO fieldloop_app;
GRANT SELECT, INSERT, DELETE ON simulation_command TO fieldloop_app;

-- The run identity is the ingestion fence. Consumers must carry signal.simulationRunId
-- through their transaction using set_config('app.simulation_run_id', <id>, true).
CREATE FUNCTION assert_simulation_run(run_id uuid, organisation text) RETURNS void AS $$
BEGIN
    PERFORM 1 FROM app.simulation_run r
    JOIN app.simulation_workspace w ON w.active_run_id = r.id AND w.org_id = r.org_id
    WHERE r.id = run_id AND r.org_id = organisation AND r.simulated AND r.state <> 'retired'
    FOR SHARE OF r;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SimulationRun is not current for this Organisation' USING ERRCODE = 'check_violation';
    END IF;
END;
$$ LANGUAGE plpgsql SET search_path = app, pg_temp;

CREATE FUNCTION guard_simulation_record() RETURNS trigger AS $$
DECLARE
    active_id uuid;
    reset_allowed boolean;
BEGIN
    reset_allowed := current_setting('app.simulation_reset', true) = 'on'
        AND current_user::regrole = (SELECT relowner FROM pg_class WHERE oid = 'app.simulation_workspace'::regclass);
    IF reset_allowed THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.org_id <> OLD.org_id OR NEW.simulated <> OLD.simulated) THEN
        RAISE EXCEPTION 'Record simulation scope is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.simulation_retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'Retired simulation history is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT NEW.simulated THEN
        IF NEW.simulation_run_id IS NOT NULL OR NEW.simulation_retired_at IS NOT NULL THEN
            RAISE EXCEPTION 'Real records cannot belong to a SimulationRun' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.simulation_retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'Only reset can retire a simulated record' USING ERRCODE = 'check_violation';
    END IF;
    SELECT active_run_id INTO active_id FROM app.simulation_workspace WHERE org_id = NEW.org_id;
    NEW.simulation_run_id := COALESCE(NEW.simulation_run_id, NULLIF(current_setting('app.simulation_run_id', true), '')::uuid);
    IF active_id IS NOT NULL OR NEW.simulation_run_id IS NOT NULL THEN
        PERFORM app.assert_simulation_run(NEW.simulation_run_id, NEW.org_id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = app, pg_temp;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['signal', 'evidence', 'geo_reference', 'health_proposal',
        'health_change', 'risk_snapshot', 'action_request', 'command_package', 'notification'] LOOP
        EXECUTE format('ALTER TABLE app.%I ADD COLUMN simulation_run_id uuid REFERENCES app.simulation_run(id), ADD COLUMN simulation_retired_at timestamptz', table_name);
        EXECUTE format('CREATE INDEX %I ON app.%I (org_id, simulation_run_id)', 'idx_' || table_name || '_simulation_run', table_name);
        EXECUTE format('CREATE TRIGGER guard_simulation_record BEFORE INSERT OR UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.guard_simulation_record()', table_name);
        EXECUTE format('CREATE VIEW app.%I AS SELECT * FROM app.%I WHERE simulation_retired_at IS NULL', 'current_' || table_name, table_name);
        EXECUTE format('GRANT SELECT ON app.%I TO fieldloop_app', 'current_' || table_name);
    END LOOP;
END $$;
ALTER TABLE notification ADD CONSTRAINT simulated_notification_sandbox CHECK (NOT simulated OR sandbox);

CREATE FUNCTION guard_simulation_barrier() RETURNS trigger AS $$
DECLARE
    organisation text;
    active_id uuid;
BEGIN
    IF current_setting('app.simulation_reset', true) = 'on'
        AND current_user::regrole = (SELECT relowner FROM pg_class WHERE oid = 'app.simulation_workspace'::regclass) THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        organisation := OLD.org_id;
        IF NOT OLD.simulated THEN RETURN OLD; END IF;
    ELSE
        organisation := NEW.org_id;
        IF TG_OP = 'UPDATE' AND (NEW.org_id <> OLD.org_id OR NEW.simulated <> OLD.simulated) THEN
            RAISE EXCEPTION 'Barrier simulation scope is immutable' USING ERRCODE = 'check_violation';
        END IF;
        IF NOT NEW.simulated THEN RETURN NEW; END IF;
    END IF;
    SELECT active_run_id INTO active_id FROM app.simulation_workspace WHERE org_id = organisation;
    IF active_id IS NOT NULL THEN
        IF TG_OP <> 'UPDATE' THEN
            RAISE EXCEPTION 'The simulation Barrier baseline cannot change during a run' USING ERRCODE = 'check_violation';
        END IF;
        PERFORM app.assert_simulation_run(NULLIF(current_setting('app.simulation_run_id', true), '')::uuid, organisation);
        IF NEW.org_id <> OLD.org_id OR NEW.simulated <> OLD.simulated THEN
            RAISE EXCEPTION 'Barrier scope cannot change during a run' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql SET search_path = app, pg_temp;
CREATE TRIGGER guard_simulation_barrier BEFORE INSERT OR UPDATE OR DELETE ON barrier
FOR EACH ROW EXECUTE FUNCTION guard_simulation_barrier();

-- The first run requires a clean demo baseline: no live simulated actions or proposals.
-- Restoring approved requests would revive old human approvals, so it is deliberately refused.
CREATE FUNCTION capture_simulation_baseline(organisation text) RETURNS void AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM app.simulation_workspace WHERE org_id = organisation) THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM app.current_action_request WHERE org_id = organisation AND simulated)
        OR EXISTS (SELECT 1 FROM app.current_health_proposal WHERE org_id = organisation AND simulated)
        OR EXISTS (SELECT 1 FROM app.current_notification WHERE org_id = organisation AND simulated) THEN
        RAISE EXCEPTION 'A clean simulated baseline is required before the first run' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO app.simulation_workspace (org_id, baseline, simulated, classification)
    VALUES (organisation, jsonb_build_object(
        'barriers', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'health', health)) FROM app.barrier WHERE org_id = organisation AND simulated), '[]'::jsonb),
        'risks', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM app.current_risk_snapshot r WHERE org_id = organisation AND simulated), '[]'::jsonb)
    ), true, 'HIGHLY_RESTRICTED');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;

CREATE FUNCTION restore_simulation_baseline(organisation text) RETURNS void AS $$
DECLARE
    workspace app.simulation_workspace%ROWTYPE;
    table_name text;
BEGIN
    SELECT * INTO STRICT workspace FROM app.simulation_workspace WHERE org_id = organisation FOR UPDATE;
    -- Shared locks in assert_simulation_run serialize in-flight worker writes with this reset.
    PERFORM 1 FROM app.simulation_run WHERE id = workspace.active_run_id FOR UPDATE;
    UPDATE app.simulation_run SET state = 'retired' WHERE id = workspace.active_run_id AND org_id = organisation;
    PERFORM set_config('app.simulation_reset', 'on', true);
    FOREACH table_name IN ARRAY ARRAY['signal', 'evidence', 'geo_reference', 'health_proposal',
        'health_change', 'risk_snapshot', 'action_request', 'command_package', 'notification'] LOOP
        EXECUTE format('UPDATE app.%I SET simulation_retired_at = now() WHERE org_id = $1 AND simulated AND simulation_run_id = $2 AND simulation_retired_at IS NULL', table_name)
        USING organisation, workspace.active_run_id;
    END LOOP;
    UPDATE app.barrier b SET health = record.health
    FROM jsonb_to_recordset(workspace.baseline->'barriers') AS record(id uuid, health text)
    WHERE b.id = record.id AND b.org_id = organisation AND b.simulated;
    UPDATE app.risk_snapshot r SET top_event_freq = record.top_event_freq,
        per_consequence_cells = record.per_consequence_cells, trigger = record.trigger,
        simulation_run_id = record.simulation_run_id, simulation_retired_at = NULL
    FROM jsonb_to_recordset(workspace.baseline->'risks') AS record(id uuid, top_event_freq numeric, per_consequence_cells jsonb, trigger text, simulation_run_id uuid)
    WHERE r.id = record.id AND r.org_id = organisation AND r.simulated;
    PERFORM set_config('app.simulation_reset', 'off', true);
    UPDATE app.simulation_workspace SET active_run_id = NULL WHERE org_id = organisation;
    INSERT INTO app.audit_event (org_id, actor, action, entity, simulated, classification)
    VALUES (organisation, 'simulator', 'simulation.reset', workspace.active_run_id::text, true, 'INTERNAL');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;
REVOKE ALL ON FUNCTION capture_simulation_baseline(text), restore_simulation_baseline(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION capture_simulation_baseline(text), restore_simulation_baseline(text) TO fieldloop_app;

-- Runtime IAM identities receive only the database matching their environment, like the BFF.
DO $$
DECLARE
    identity text;
    runtime_role text;
    app_role text;
    table_name text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        identity := 'fl-v2-simulator-' || replace(current_database(), 'fieldloop_', '') || '@example-project.iam';
        runtime_role := 'fieldloop_simulator_' || replace(current_database(), 'fieldloop_', '');
        app_role := 'fieldloop_app_' || replace(current_database(), 'fieldloop_', '');
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', runtime_role);
        END IF;
        EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', runtime_role);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON app.scenario, app.simulation_run, app.simulation_workspace TO %I', runtime_role);
        EXECUTE format('GRANT SELECT, INSERT, DELETE ON app.simulation_command TO %I', runtime_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION app.capture_simulation_baseline(text), app.restore_simulation_baseline(text) TO %I', runtime_role);
        EXECUTE format('GRANT SELECT ON app.simulation_workspace TO %I', app_role);
        FOREACH table_name IN ARRAY ARRAY['signal', 'evidence', 'geo_reference', 'health_proposal',
            'health_change', 'risk_snapshot', 'action_request', 'command_package', 'notification'] LOOP
            EXECUTE format('GRANT SELECT ON app.%I TO %I', 'current_' || table_name, app_role);
        END LOOP;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = identity) THEN
            EXECUTE format('GRANT %I TO %I', runtime_role, identity);
        END IF;
    END IF;
END $$;

-- A queued executor cannot use a retired ActionRequest or relabel its children as real.
CREATE FUNCTION guard_simulation_action_child() RETURNS trigger AS $$
DECLARE
    parent app.action_request%ROWTYPE;
BEGIN
    IF current_setting('app.simulation_reset', true) = 'on'
        AND current_user::regrole = (SELECT relowner FROM pg_class WHERE oid = 'app.simulation_workspace'::regclass) THEN
        RETURN NEW;
    END IF;
    SELECT * INTO STRICT parent FROM app.action_request WHERE id = NEW.action_request_id FOR SHARE;
    IF parent.org_id <> NEW.org_id OR parent.simulated <> NEW.simulated OR parent.simulation_retired_at IS NOT NULL THEN
        RAISE EXCEPTION 'ActionRequest child scope is invalid or retired' USING ERRCODE = 'check_violation';
    END IF;
    IF parent.simulation_run_id IS NOT NULL THEN
        PERFORM app.assert_simulation_run(parent.simulation_run_id, parent.org_id);
        IF TG_TABLE_NAME <> 'approval' THEN
            IF NEW.simulation_run_id IS DISTINCT FROM parent.simulation_run_id THEN
                RAISE EXCEPTION 'ActionRequest child belongs to another run' USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = app, pg_temp;
CREATE TRIGGER zz_guard_simulation_action_child BEFORE INSERT OR UPDATE ON notification
FOR EACH ROW EXECUTE FUNCTION guard_simulation_action_child();
CREATE TRIGGER zz_guard_simulation_action_child BEFORE INSERT OR UPDATE ON command_package
FOR EACH ROW EXECUTE FUNCTION guard_simulation_action_child();
CREATE TRIGGER zz_guard_simulation_action_child BEFORE INSERT ON approval
FOR EACH ROW EXECUTE FUNCTION guard_simulation_action_child();

-- migrate:down
SET search_path = app, public;
DROP TRIGGER zz_guard_simulation_action_child ON notification;
DROP TRIGGER zz_guard_simulation_action_child ON command_package;
DROP TRIGGER zz_guard_simulation_action_child ON approval;
DROP FUNCTION guard_simulation_action_child();
DROP TRIGGER guard_simulation_barrier ON barrier;
DROP FUNCTION guard_simulation_barrier();
ALTER TABLE notification DROP CONSTRAINT simulated_notification_sandbox;
DO $$
DECLARE
    table_name text;
    identity text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['signal', 'evidence', 'geo_reference', 'health_proposal',
        'health_change', 'risk_snapshot', 'action_request', 'command_package', 'notification'] LOOP
        EXECUTE format('DROP VIEW app.%I', 'current_' || table_name);
        EXECUTE format('DROP TRIGGER guard_simulation_record ON app.%I', table_name);
        EXECUTE format('ALTER TABLE app.%I DROP COLUMN simulation_run_id, DROP COLUMN simulation_retired_at', table_name);
    END LOOP;
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        identity := 'fl-v2-simulator-' || replace(current_database(), 'fieldloop_', '') || '@example-project.iam';
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = identity) THEN
            EXECUTE format('REVOKE %I FROM %I', 'fieldloop_simulator_' || replace(current_database(), 'fieldloop_', ''), identity);
        END IF;
        EXECUTE format('REVOKE USAGE ON SCHEMA app FROM %I', 'fieldloop_simulator_' || replace(current_database(), 'fieldloop_', ''));
        EXECUTE format('REVOKE ALL ON app.scenario, app.simulation_run, app.simulation_workspace, app.simulation_command FROM %I', 'fieldloop_simulator_' || replace(current_database(), 'fieldloop_', ''));
        EXECUTE format('REVOKE ALL ON FUNCTION app.capture_simulation_baseline(text), app.restore_simulation_baseline(text) FROM %I', 'fieldloop_simulator_' || replace(current_database(), 'fieldloop_', ''));
    END IF;
END $$;
DROP FUNCTION capture_simulation_baseline(text), restore_simulation_baseline(text);
DROP FUNCTION guard_simulation_record(), assert_simulation_run(uuid, text);
DROP TABLE simulation_command;
DROP TABLE simulation_workspace;
ALTER TABLE simulation_run DROP COLUMN player_state;
