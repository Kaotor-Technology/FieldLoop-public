DO $$
DECLARE
    dev_user text := 'fl-v2-web-api-dev@example-project.iam';
    demo_user text := 'fl-v2-web-api-demo@example-project.iam';
BEGIN
    IF current_database() = 'fieldloop_dev' THEN
        IF NOT has_schema_privilege(dev_user, 'app', 'USAGE')
            OR NOT has_table_privilege(dev_user, 'app.user_session', 'SELECT')
            OR has_table_privilege(demo_user, 'app.user_session', 'SELECT')
            OR NOT pg_has_role(dev_user, 'fieldloop_app_dev', 'member')
            OR pg_has_role(dev_user, 'fieldloop_app_demo', 'member') THEN
            RAISE EXCEPTION 'Dev BFF privileges crossed the environment boundary';
        END IF;
        IF has_table_privilege(dev_user, 'app.audit_event', 'UPDATE')
            OR has_table_privilege(dev_user, 'app.approval', 'DELETE') THEN
            RAISE EXCEPTION 'Dev BFF can mutate append-only audit or approval records';
        END IF;
    ELSIF current_database() = 'fieldloop_demo' THEN
        IF NOT has_schema_privilege(demo_user, 'app', 'USAGE')
            OR NOT has_table_privilege(demo_user, 'app.user_session', 'SELECT')
            OR has_table_privilege(dev_user, 'app.user_session', 'SELECT')
            OR NOT pg_has_role(demo_user, 'fieldloop_app_demo', 'member')
            OR pg_has_role(demo_user, 'fieldloop_app_dev', 'member') THEN
            RAISE EXCEPTION 'Demo BFF privileges crossed the environment boundary';
        END IF;
        IF has_table_privilege(demo_user, 'app.audit_event', 'UPDATE')
            OR has_table_privilege(demo_user, 'app.approval', 'DELETE') THEN
            RAISE EXCEPTION 'Demo BFF can mutate append-only audit or approval records';
        END IF;
    ELSE
        NULL;
    END IF;
END $$;
