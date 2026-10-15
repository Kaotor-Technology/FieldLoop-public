-- migrate:up
-- A row-locking SELECT requires UPDATE permission. Keep that privilege inside
-- this validation-only function, never on the worker's SimulationRun table grant.
ALTER FUNCTION app.assert_simulation_run(uuid, text) SECURITY DEFINER;
ALTER FUNCTION app.assert_simulation_run(uuid, text) SET search_path = pg_catalog, app;
REVOKE ALL ON FUNCTION app.assert_simulation_run(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_simulation_run(uuid, text) TO fieldloop_app;
DO $$
DECLARE role_name text; environment text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        environment := replace(current_database(), 'fieldloop_', '');
        FOREACH role_name IN ARRAY ARRAY[
            'fieldloop_app_' || environment,
            'fieldloop_simulator_' || environment,
            'fl-v2-simulator-' || environment || '@example-project.iam',
            'fl-v2-signal-worker-' || environment || '@example-project.iam'
        ] LOOP
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION app.assert_simulation_run(uuid, text) TO %I', role_name);
            END IF;
        END LOOP;
    END IF;
END $$;

-- Match the existing Guardrail role suffix on every supported database, including
-- restricted and test databases; grant only when that exact role already exists.
DO $$
DECLARE guardrail_role text;
BEGIN
    guardrail_role := 'fieldloop_guardrail_' || replace(current_database(), 'fieldloop_', '');
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = guardrail_role) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION app.assert_simulation_run(uuid, text) TO %I', guardrail_role);
    END IF;
END $$;

-- migrate:down
-- Restore the preceding invoker-rights function and its public execute policy.
ALTER FUNCTION app.assert_simulation_run(uuid, text) SECURITY INVOKER;
ALTER FUNCTION app.assert_simulation_run(uuid, text) SET search_path = app, pg_temp;
GRANT EXECUTE ON FUNCTION app.assert_simulation_run(uuid, text) TO PUBLIC;
