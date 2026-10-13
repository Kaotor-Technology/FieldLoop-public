-- The runtime can reset only in the database of its environment, and never bypass record fences.
DO $$
DECLARE
    expected text;
    other text;
BEGIN
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN RETURN; END IF;
    expected := 'fl-v2-simulator-' || replace(current_database(), 'fieldloop_', '') || '@example-project.iam';
    other := 'fl-v2-simulator-' || CASE WHEN current_database()='fieldloop_dev' THEN 'demo' ELSE 'dev' END || '@example-project.iam';
    IF NOT pg_has_role(expected, 'fieldloop_simulator_' || replace(current_database(), 'fieldloop_', ''), 'MEMBER') OR pg_has_role(other, 'fieldloop_simulator_' || replace(current_database(), 'fieldloop_', ''), 'MEMBER') THEN
        RAISE EXCEPTION 'simulator database role crossed environments';
    END IF;
    IF NOT has_function_privilege(expected, 'app.restore_simulation_baseline(text)', 'EXECUTE')
        OR has_table_privilege(expected, 'app.audit_event', 'UPDATE')
        OR has_table_privilege(expected, 'app.approval', 'DELETE')
        OR has_table_privilege(expected, 'app.user_session', 'SELECT') THEN
        RAISE EXCEPTION 'simulator reset privileges bypass immutable history';
    END IF;
END $$;
