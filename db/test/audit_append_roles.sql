-- Runtime identities may append audit events only through app.append_audit_event (FL-91).
-- Runs against the dev and demo databases; other databases have no environment roles.
DO $$
DECLARE
    environment text;
    other text;
    signature text := 'app.append_audit_event(text, text, text, text, text, text, boolean, text, text)';
    role_name text;
BEGIN
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN RETURN; END IF;
    environment := replace(current_database(), 'fieldloop_', '');
    other := CASE environment WHEN 'dev' THEN 'demo' ELSE 'dev' END;
    FOREACH role_name IN ARRAY ARRAY['fieldloop_app_' || environment, 'fieldloop_guardrail_' || environment,
        'fl-v2-web-api-' || environment || '@example-project.iam',
        'fl-v2-signal-worker-' || environment || '@example-project.iam'] LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name)
            AND NOT has_function_privilege(role_name, signature, 'EXECUTE') THEN
            RAISE EXCEPTION '% cannot execute the shared audit append function', role_name;
        END IF;
    END LOOP;
    FOREACH role_name IN ARRAY ARRAY['fieldloop_app_' || other, 'fieldloop_guardrail_' || other,
        'fl-v2-simulator-' || environment || '@example-project.iam',
        'fl-v2-web-api-' || other || '@example-project.iam'] LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name)
            AND has_function_privilege(role_name, signature, 'EXECUTE') THEN
            RAISE EXCEPTION '% must not execute the shared audit append function in this database', role_name;
        END IF;
    END LOOP;
END $$;
