-- migrate:up
-- Simulation triggers on Intercept, Evidence and outbox rows read the active run fence
-- (simulation_workspace) and validate runs (simulation_run) as the inserting role.
-- Guardrail inserts simulated records, so it needs the same read-only access as the worker.
SET search_path = app, public;
DO $$
DECLARE guardrail_role text;
BEGIN
    guardrail_role := 'fieldloop_guardrail_' || replace(current_database(), 'fieldloop_', '');
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = guardrail_role) THEN
        EXECUTE format('GRANT SELECT ON app.simulation_run, app.simulation_workspace TO %I', guardrail_role);
    END IF;
END $$;

-- migrate:down
SET search_path = app, public;
DO $$
DECLARE guardrail_role text;
BEGIN
    guardrail_role := 'fieldloop_guardrail_' || replace(current_database(), 'fieldloop_', '');
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = guardrail_role) THEN
        EXECUTE format('REVOKE SELECT ON app.simulation_run, app.simulation_workspace FROM %I', guardrail_role);
    END IF;
END $$;
