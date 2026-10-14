DO $$
DECLARE
    environment text;
    own_runtime_role text;
    other_runtime_role text;
    own_guardrail_role text;
    other_guardrail_role text;
BEGIN
    IF current_database() = 'fieldloop_test' THEN
        RETURN;
    END IF;
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN
        RAISE EXCEPTION 'Guardrail role regression must run in a FieldLoop environment database';
    END IF;

    environment := replace(current_database(), 'fieldloop_', '');
    own_runtime_role := 'fl-v2-guardrail-' || environment || '@example-project.iam';
    other_runtime_role := 'fl-v2-guardrail-' || CASE environment WHEN 'dev' THEN 'demo' ELSE 'dev' END || '@example-project.iam';
    own_guardrail_role := 'fieldloop_guardrail_' || environment;
    other_guardrail_role := 'fieldloop_guardrail_' || CASE environment WHEN 'dev' THEN 'demo' ELSE 'dev' END;

    IF NOT pg_has_role(own_runtime_role, own_guardrail_role, 'MEMBER') THEN
        RAISE EXCEPTION 'Guardrail runtime role is missing its environment membership';
    END IF;
    IF pg_has_role(own_runtime_role, other_guardrail_role, 'MEMBER')
        OR pg_has_role(other_runtime_role, own_guardrail_role, 'MEMBER') THEN
        RAISE EXCEPTION 'Guardrail role membership crosses environment boundaries';
    END IF;
    IF NOT has_table_privilege(own_runtime_role, 'app.ai_system', 'SELECT')
        OR NOT has_table_privilege(own_runtime_role, 'app.guardrail_policy', 'SELECT')
        OR NOT has_table_privilege(own_runtime_role, 'app.intercept', 'INSERT')
        OR NOT has_table_privilege(own_runtime_role, 'app.evidence', 'INSERT')
        OR NOT has_table_privilege(own_runtime_role, 'app.signal_event_outbox', 'INSERT')
        OR NOT has_table_privilege(own_runtime_role, 'app.guardrail_content_request', 'SELECT')
        OR NOT has_table_privilege(own_runtime_role, 'app.guardrail_content_request', 'INSERT')
        OR NOT has_table_privilege(own_runtime_role, 'app.simulation_run', 'SELECT')
        OR NOT has_table_privilege(own_runtime_role, 'app.simulation_workspace', 'SELECT') THEN
        RAISE EXCEPTION 'Guardrail runtime role is missing an approved database privilege';
    END IF;
    IF has_table_privilege(own_runtime_role, 'app.intercept', 'SELECT')
        OR has_table_privilege(own_runtime_role, 'app.evidence', 'SELECT')
        OR has_table_privilege(own_runtime_role, 'app.signal_event_outbox', 'SELECT')
        OR has_table_privilege(own_runtime_role, 'app.guardrail_content_request', 'UPDATE')
        OR has_table_privilege(own_runtime_role, 'app.guardrail_content_request', 'DELETE')
        OR has_table_privilege(own_runtime_role, 'app.simulation_workspace', 'UPDATE')
        OR has_table_privilege(own_runtime_role, 'app.simulation_run', 'INSERT') THEN
        RAISE EXCEPTION 'Guardrail runtime role has an unapproved database privilege';
    END IF;
END $$;
