-- migrate:up
-- Cloud SQL IAM database usernames can contain '-' and '@'; they are valid role
-- names but are not valid unquoted regrole input. Compare the names as text.
CREATE OR REPLACE FUNCTION app.simulation_reset_authorized() RETURNS boolean AS $$
    SELECT current_setting('app.simulation_reset', true) = 'on'
        AND current_user = (
            SELECT pg_catalog.pg_get_userbyid(relowner)
            FROM pg_catalog.pg_class
            WHERE oid = 'app.simulation_workspace'::regclass
        );
$$ LANGUAGE sql STABLE SET search_path = app, pg_temp;

CREATE OR REPLACE FUNCTION app.guard_simulation_record() RETURNS trigger AS $$
DECLARE
    active_id uuid;
    reset_allowed boolean;
BEGIN
    reset_allowed := app.simulation_reset_authorized();
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

CREATE OR REPLACE FUNCTION app.guard_simulation_barrier() RETURNS trigger AS $$
DECLARE
    organisation text;
    active_id uuid;
BEGIN
    IF app.simulation_reset_authorized() THEN RETURN NEW; END IF;
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

CREATE OR REPLACE FUNCTION app.guard_simulation_action_child() RETURNS trigger AS $$
DECLARE
    parent app.action_request%ROWTYPE;
BEGIN
    IF app.simulation_reset_authorized() THEN RETURN NEW; END IF;
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

-- Worker triggers validate a supplied Scenario run and must read the active run
-- fence. Keep this read-only and grant it only to the environment's worker IAM role.
DO $$
DECLARE worker_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        worker_role := 'fl-v2-signal-worker-' || replace(current_database(), 'fieldloop_', '') || '@example-project.iam';
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = worker_role) THEN
            EXECUTE format('GRANT SELECT ON app.simulation_run, app.simulation_workspace TO %I', worker_role);
        END IF;
    END IF;
END $$;

-- migrate:down
CREATE OR REPLACE FUNCTION app.simulation_reset_authorized() RETURNS boolean AS $$
    SELECT current_setting('app.simulation_reset', true) = 'on'
        AND current_user::regrole = (
            SELECT relowner
            FROM pg_catalog.pg_class
            WHERE oid = 'app.simulation_workspace'::regclass
        );
$$ LANGUAGE sql STABLE SET search_path = app, pg_temp;
DO $$
DECLARE worker_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        worker_role := 'fl-v2-signal-worker-' || replace(current_database(), 'fieldloop_', '') || '@example-project.iam';
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = worker_role) THEN
            EXECUTE format('REVOKE SELECT ON app.simulation_run, app.simulation_workspace FROM %I', worker_role);
        END IF;
    END IF;
END $$;
