DO $$
DECLARE
    environment text;
    own_runtime_role text;
    other_runtime_role text;
    own_role text;
    other_role text;
BEGIN
    IF current_database() = 'fieldloop_test' THEN
        RETURN;
    END IF;
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN
        RAISE EXCEPTION 'Assistant role regression must run in a FieldLoop environment database';
    END IF;

    environment := replace(current_database(), 'fieldloop_', '');
    own_runtime_role := 'fl-v2-assistant-' || environment || '@example-project.iam';
    other_runtime_role := 'fl-v2-assistant-' || CASE environment WHEN 'dev' THEN 'demo' ELSE 'dev' END || '@example-project.iam';
    own_role := 'fieldloop_assistant_' || environment;
    other_role := 'fieldloop_assistant_' || CASE environment WHEN 'dev' THEN 'demo' ELSE 'dev' END;

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = own_role) THEN
        RAISE EXCEPTION 'Assistant environment role is missing';
    END IF;
    IF NOT pg_has_role(own_runtime_role, own_role, 'MEMBER') THEN
        RAISE EXCEPTION 'Assistant runtime role is missing its environment membership';
    END IF;
    IF pg_has_role(other_runtime_role, own_role, 'MEMBER') OR pg_has_role(own_runtime_role, other_role, 'MEMBER') THEN
        RAISE EXCEPTION 'Assistant role membership crosses environment boundaries';
    END IF;
    IF pg_has_role(own_role, other_role, 'MEMBER') THEN
        RAISE EXCEPTION 'Assistant roles overlap between environments';
    END IF;

    IF NOT has_table_privilege(own_role, 'app.assistant_session', 'INSERT')
        OR NOT has_table_privilege(own_role, 'app.assistant_session', 'SELECT')
        OR NOT has_column_privilege(own_role, 'app.assistant_session', 'status', 'UPDATE')
        OR NOT has_table_privilege(own_role, 'app.agent_step', 'INSERT')
        OR NOT has_table_privilege(own_role, 'app.draft', 'INSERT')
        OR NOT has_table_privilege(own_role, 'app.document_chunk', 'SELECT') THEN
        RAISE EXCEPTION 'Assistant role is missing an approved database privilege';
    END IF;

    -- An agent can never change the world or approve: no write to records of other services.
    IF has_table_privilege(own_role, 'app.agent_step', 'UPDATE')
        OR has_table_privilege(own_role, 'app.agent_step', 'DELETE')
        OR has_table_privilege(own_role, 'app.assistant_session', 'DELETE')
        OR has_column_privilege(own_role, 'app.assistant_session', 'org_id', 'UPDATE')
        OR has_column_privilege(own_role, 'app.assistant_session', 'created_by', 'UPDATE')
        OR has_table_privilege(own_role, 'app.draft', 'UPDATE')
        OR has_table_privilege(own_role, 'app.draft', 'DELETE')
        OR has_column_privilege(own_role, 'app.draft', 'content', 'SELECT')
        OR has_table_privilege(own_role, 'app.action_request', 'INSERT')
        OR has_table_privilege(own_role, 'app.action_request', 'UPDATE')
        OR has_table_privilege(own_role, 'app.held_request', 'INSERT')
        OR has_table_privilege(own_role, 'app.health_proposal', 'INSERT')
        OR has_table_privilege(own_role, 'app.controlled_document', 'UPDATE')
        OR has_table_privilege(own_role, 'app.document_chunk', 'INSERT') THEN
        RAISE EXCEPTION 'Assistant role has an unapproved database privilege';
    END IF;
END $$;
