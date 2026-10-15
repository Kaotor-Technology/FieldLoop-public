-- migrate:up
-- IAM SQL logins may be provisioned after the original simulation migration.
-- Reconcile the existing restricted role, never grant table privileges directly.
DO $$
DECLARE
    environment text;
    identity text;
    runtime_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        environment := replace(current_database(), 'fieldloop_', '');
        identity := 'fl-v2-simulator-' || environment || '@example-project.iam';
        runtime_role := 'fieldloop_simulator_' || environment;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = identity) THEN
            EXECUTE format('GRANT %I TO %I', runtime_role, identity);
        END IF;
    END IF;
END $$;

-- migrate:down
-- Membership belongs to simulation_reset's original contract. Its down migration
-- removes it; rolling back this reconciliation must not remove an earlier grant.
SELECT 1;
