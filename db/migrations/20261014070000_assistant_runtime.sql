-- migrate:up
SET search_path = app, public;
-- Turn claim and stale-turn recovery (architecture §7.5): when the status last changed.
ALTER TABLE assistant_session ADD COLUMN status_updated_at timestamptz NOT NULL DEFAULT now();
DO $$
DECLARE
    environment text;
    assistant_role text;
    runtime_role text;
BEGIN
    -- Roles and grants exist only in FieldLoop dev/demo and the repo's fieldloop_*test databases.
    IF NOT (current_database() IN ('fieldloop_dev', 'fieldloop_demo', 'fieldloop_restricted') OR current_database() LIKE 'fieldloop\_%test') THEN
        RETURN;
    END IF;

    environment := replace(current_database(), 'fieldloop_', '');
    assistant_role := 'fieldloop_assistant_' || environment;
    runtime_role := 'fl-v2-assistant-' || environment || '@example-project.iam';

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = assistant_role) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN', assistant_role);
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', assistant_role);
    -- Sessions and trace (architecture §7.6): create, read back, and update the status only.
    EXECUTE format('GRANT SELECT, INSERT ON app.assistant_session, app.agent_step TO %I', assistant_role);
    EXECUTE format('GRANT UPDATE (status, status_updated_at, token_budget_used) ON app.assistant_session TO %I', assistant_role);
    EXECUTE format('GRANT SELECT (id, keycloak_sub, org_id) ON app.app_user TO %I', assistant_role);
    -- Drafts wait for a person: insert only, and read back the new id.
    EXECUTE format('GRANT INSERT ON app.draft TO %I', assistant_role);
    EXECUTE format('GRANT SELECT (id) ON app.draft TO %I', assistant_role);
    -- Retrieval primitive (FL-70).
    EXECUTE format('GRANT SELECT ON app.controlled_document, app.document_chunk TO %I', assistant_role);

    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo')
        AND EXISTS (SELECT FROM pg_roles WHERE rolname = runtime_role) THEN
        EXECUTE format('GRANT %I TO %I', assistant_role, runtime_role);
    END IF;
END $$;

-- migrate:down
SET search_path = app, public;
DO $$
DECLARE
    environment text;
    assistant_role text;
    runtime_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo', 'fieldloop_restricted') OR current_database() LIKE 'fieldloop\_%test' THEN
        environment := replace(current_database(), 'fieldloop_', '');
        assistant_role := 'fieldloop_assistant_' || environment;
        runtime_role := 'fl-v2-assistant-' || environment || '@example-project.iam';
        IF current_database() IN ('fieldloop_dev', 'fieldloop_demo')
            AND EXISTS (SELECT FROM pg_roles WHERE rolname = runtime_role) THEN
            EXECUTE format('REVOKE %I FROM %I', assistant_role, runtime_role);
        END IF;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = assistant_role) THEN
            EXECUTE format('REVOKE ALL ON app.assistant_session, app.agent_step, app.app_user, app.draft, app.controlled_document, app.document_chunk FROM %I', assistant_role);
            EXECUTE format('REVOKE USAGE ON SCHEMA app FROM %I', assistant_role);
            EXECUTE format('DROP ROLE %I', assistant_role);
        END IF;
    END IF;
END $$;
ALTER TABLE assistant_session DROP COLUMN status_updated_at;
