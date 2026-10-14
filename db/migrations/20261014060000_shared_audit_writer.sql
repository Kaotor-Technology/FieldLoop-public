-- migrate:up
SET search_path = app, public;

-- FL-91: one append protocol for audit_event (PRD section 10 Audit, architecture section 5.3).
-- Every producer, in every language, calls app.append_audit_event. The function takes the
-- Organisation lock, reads the predecessor, and computes prev_hash and the row hash in UTC, so
-- the chain does not depend on a caller's session. A guard trigger rejects any other INSERT.

-- SHA-256 of a stored audit row over a FROZEN v1 field list (not to_jsonb(row)), so a column added
-- to audit_event later never changes the hash of an existing row. jsonb orders keys itself, and
-- the values serialize as to_jsonb(row) did, so rows written before this function hash the same.
-- The function-level time zone makes the timestamptz text independent of the caller's TimeZone.
-- To hash more fields, add a new hash version; never edit this list.
CREATE FUNCTION audit_event_hash(event app.audit_event)
RETURNS text AS $$
    SELECT app.payload_sha256(jsonb_build_object(
        'id', event.id, 'org_id', event.org_id, 'actor', event.actor, 'action', event.action,
        'entity', event.entity, 'before_hash', event.before_hash, 'after_hash', event.after_hash,
        'prev_hash', event.prev_hash, 'simulated', event.simulated, 'classification', event.classification,
        'created_at', event.created_at, 'created_by', event.created_by));
$$ LANGUAGE sql STABLE STRICT SET timezone = 'UTC';

-- Lock order rule: take domain row locks first and call this function last in the transaction,
-- so the Organisation lock never waits on a domain lock held by another audit writer. The
-- function joins the caller's transaction and never commits; it needs READ COMMITTED so the
-- predecessor read after the lock sees every committed append.
CREATE FUNCTION append_audit_event(
    p_org_id text, p_actor text, p_action text, p_entity text,
    p_before_hash text, p_after_hash text, p_simulated boolean, p_classification text,
    p_created_by text DEFAULT NULL
) RETURNS TABLE (event_id uuid, previous_hash text, event_hash text) AS $$
DECLARE
    predecessor app.audit_event%ROWTYPE;
    appended app.audit_event%ROWTYPE;
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'audit_event must be appended in a READ COMMITTED transaction'
            USING ERRCODE = 'invalid_transaction_state';
    END IF;
    IF COALESCE(btrim(p_org_id), '') = '' OR COALESCE(btrim(p_actor), '') = ''
        OR COALESCE(btrim(p_action), '') = '' OR COALESCE(btrim(p_entity), '') = ''
        OR p_before_hash !~ '^[a-f0-9]{64}$' OR p_after_hash !~ '^[a-f0-9]{64}$'
        OR p_simulated IS NULL
        OR p_classification IS NULL OR p_classification NOT IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED') THEN
        RAISE EXCEPTION 'Invalid audit metadata' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fieldloop:audit:' || p_org_id, 0));
    SELECT * INTO predecessor FROM app.audit_event AS e
    WHERE e.org_id = p_org_id ORDER BY e.created_at DESC, e.id DESC LIMIT 1;
    INSERT INTO app.audit_event (org_id, actor, action, entity, before_hash, after_hash, prev_hash,
        simulated, classification, created_at, created_by)
    VALUES (p_org_id, p_actor, p_action, p_entity, p_before_hash, p_after_hash,
        CASE WHEN predecessor.id IS NULL THEN NULL ELSE app.audit_event_hash(predecessor) END,
        p_simulated, p_classification,
        GREATEST(clock_timestamp(), predecessor.created_at + interval '1 microsecond'),
        COALESCE(p_created_by, p_actor))
    RETURNING * INTO appended;
    RETURN QUERY SELECT appended.id, appended.prev_hash, app.audit_event_hash(appended);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp;
REVOKE ALL ON FUNCTION audit_event_hash(app.audit_event), append_audit_event(text, text, text, text, text, text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_event_hash(app.audit_event), append_audit_event(text, text, text, text, text, text, boolean, text, text) TO fieldloop_app;

-- Environment roles, the Guardrail runtime role and the Signal worker identity run in their own
-- database only, like the grants in migrations 9, guardrail_runtime and signal_worker. They already
-- hold INSERT on audit_event, which the guard now refuses; they append through the function.
DO $$
DECLARE environment text; role_name text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        environment := replace(current_database(), 'fieldloop_', '');
        FOREACH role_name IN ARRAY ARRAY['fieldloop_app_' || environment, 'fieldloop_guardrail_' || environment,
            'fl-v2-signal-worker-' || environment || '@example-project.iam'] LOOP
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION app.audit_event_hash(app.audit_event), app.append_audit_event(text, text, text, text, text, text, boolean, text, text) TO %I', role_name);
            END IF;
        END LOOP;
    END IF;
END $$;

CREATE FUNCTION guard_audit_event_insert()
RETURNS TRIGGER AS $$
BEGIN
    IF current_user::name IS DISTINCT FROM pg_catalog.pg_get_userbyid((
        SELECT proowner FROM pg_catalog.pg_proc
        WHERE oid = 'app.append_audit_event(text, text, text, text, text, text, boolean, text, text)'::pg_catalog.regprocedure)) THEN
        RAISE EXCEPTION 'audit_event rows are appended only through app.append_audit_event'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
CREATE TRIGGER trg_guard_audit_event_insert
BEFORE INSERT ON audit_event
FOR EACH ROW EXECUTE FUNCTION guard_audit_event_insert();

-- GET /v1/audit filters by Organisation and entity, newest first.
CREATE INDEX idx_audit_event_org_entity ON audit_event (org_id, entity, created_at DESC, id DESC);

-- The simulation reset appends through the shared function instead of a direct INSERT.
CREATE OR REPLACE FUNCTION restore_simulation_baseline(organisation text) RETURNS void AS $$
DECLARE
    workspace app.simulation_workspace%ROWTYPE;
    table_name text;
BEGIN
    SELECT * INTO STRICT workspace FROM app.simulation_workspace WHERE org_id = organisation FOR UPDATE;
    -- Shared locks in assert_simulation_run serialize in-flight worker writes with this reset.
    PERFORM 1 FROM app.simulation_run WHERE id = workspace.active_run_id FOR UPDATE;
    UPDATE app.simulation_run SET state = 'retired' WHERE id = workspace.active_run_id AND org_id = organisation;
    PERFORM set_config('app.simulation_reset', 'on', true);
    FOREACH table_name IN ARRAY ARRAY['signal', 'evidence', 'geo_reference', 'health_proposal',
        'health_change', 'risk_snapshot', 'action_request', 'command_package', 'notification'] LOOP
        EXECUTE format('UPDATE app.%I SET simulation_retired_at = now() WHERE org_id = $1 AND simulated AND simulation_run_id = $2 AND simulation_retired_at IS NULL', table_name)
        USING organisation, workspace.active_run_id;
    END LOOP;
    UPDATE app.barrier b SET health = record.health
    FROM jsonb_to_recordset(workspace.baseline->'barriers') AS record(id uuid, health text)
    WHERE b.id = record.id AND b.org_id = organisation AND b.simulated;
    UPDATE app.risk_snapshot r SET top_event_freq = record.top_event_freq,
        per_consequence_cells = record.per_consequence_cells, trigger = record.trigger,
        simulation_run_id = record.simulation_run_id, simulation_retired_at = NULL
    FROM jsonb_to_recordset(workspace.baseline->'risks') AS record(id uuid, top_event_freq numeric, per_consequence_cells jsonb, trigger text, simulation_run_id uuid)
    WHERE r.id = record.id AND r.org_id = organisation AND r.simulated;
    PERFORM set_config('app.simulation_reset', 'off', true);
    UPDATE app.simulation_workspace SET active_run_id = NULL WHERE org_id = organisation;
    -- Domain row locks are held; the audit lock is taken last, as in every producer.
    PERFORM app.append_audit_event(organisation, 'simulator', 'simulation.reset', workspace.active_run_id::text,
        NULL, NULL, true, 'INTERNAL');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;

-- migrate:down
SET search_path = app, public;
-- The reset function returns to its direct INSERT before the helper is dropped. Direct INSERT is
-- unchained again after this point; chain continuity across the down window is not guaranteed.
CREATE OR REPLACE FUNCTION restore_simulation_baseline(organisation text) RETURNS void AS $$
DECLARE
    workspace app.simulation_workspace%ROWTYPE;
    table_name text;
BEGIN
    SELECT * INTO STRICT workspace FROM app.simulation_workspace WHERE org_id = organisation FOR UPDATE;
    -- Shared locks in assert_simulation_run serialize in-flight worker writes with this reset.
    PERFORM 1 FROM app.simulation_run WHERE id = workspace.active_run_id FOR UPDATE;
    UPDATE app.simulation_run SET state = 'retired' WHERE id = workspace.active_run_id AND org_id = organisation;
    PERFORM set_config('app.simulation_reset', 'on', true);
    FOREACH table_name IN ARRAY ARRAY['signal', 'evidence', 'geo_reference', 'health_proposal',
        'health_change', 'risk_snapshot', 'action_request', 'command_package', 'notification'] LOOP
        EXECUTE format('UPDATE app.%I SET simulation_retired_at = now() WHERE org_id = $1 AND simulated AND simulation_run_id = $2 AND simulation_retired_at IS NULL', table_name)
        USING organisation, workspace.active_run_id;
    END LOOP;
    UPDATE app.barrier b SET health = record.health
    FROM jsonb_to_recordset(workspace.baseline->'barriers') AS record(id uuid, health text)
    WHERE b.id = record.id AND b.org_id = organisation AND b.simulated;
    UPDATE app.risk_snapshot r SET top_event_freq = record.top_event_freq,
        per_consequence_cells = record.per_consequence_cells, trigger = record.trigger,
        simulation_run_id = record.simulation_run_id, simulation_retired_at = NULL
    FROM jsonb_to_recordset(workspace.baseline->'risks') AS record(id uuid, top_event_freq numeric, per_consequence_cells jsonb, trigger text, simulation_run_id uuid)
    WHERE r.id = record.id AND r.org_id = organisation AND r.simulated;
    PERFORM set_config('app.simulation_reset', 'off', true);
    UPDATE app.simulation_workspace SET active_run_id = NULL WHERE org_id = organisation;
    INSERT INTO app.audit_event (org_id, actor, action, entity, simulated, classification)
    VALUES (organisation, 'simulator', 'simulation.reset', workspace.active_run_id::text, true, 'INTERNAL');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;
DROP INDEX idx_audit_event_org_entity;
DROP TRIGGER trg_guard_audit_event_insert ON audit_event;
DROP FUNCTION guard_audit_event_insert();
DROP FUNCTION append_audit_event(text, text, text, text, text, text, boolean, text, text);
DROP FUNCTION audit_event_hash(app.audit_event);
