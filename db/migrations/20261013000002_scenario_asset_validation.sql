-- migrate:up
-- Scenario targets are Asset codes. Give the simulator only the two columns it needs
-- to validate those references within its fixed Organisation.
DO $$
DECLARE
    runtime_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        runtime_role := 'fieldloop_simulator_' || replace(current_database(), 'fieldloop_', '');
        EXECUTE format(
            'GRANT SELECT (org_id, attributes) ON TABLE app.asset TO %I', runtime_role
        );
    END IF;
END $$;

-- migrate:down
DO $$
DECLARE
    runtime_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        runtime_role := 'fieldloop_simulator_' || replace(current_database(), 'fieldloop_', '');
        EXECUTE format(
            'REVOKE SELECT (org_id, attributes) ON TABLE app.asset FROM %I', runtime_role
        );
    END IF;
END $$;
