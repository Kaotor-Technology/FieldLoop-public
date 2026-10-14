-- migrate:up
SET search_path = app, public;

CREATE TABLE action_ceiling (
    org_id text NOT NULL,
    action_type text NOT NULL,
    action_level text NOT NULL CHECK (action_level IN ('l0', 'l1', 'l2')),
    sla_seconds integer NOT NULL DEFAULT 900 CHECK (sla_seconds BETWEEN 1 AND 86400),
    simulated boolean NOT NULL,
    classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    PRIMARY KEY (org_id, action_type, simulated),
    CHECK ((action_type IN ('system_of_record', 'field_command') AND action_level IN ('l0', 'l1'))
        OR (action_type = 'engineering_approval' AND action_level = 'l0')
        OR action_type IN ('internal_record', 'emergency_communication', 'external_submission'))
);
ALTER TABLE action_request ADD COLUMN target text, ADD COLUMN rejection_reason text,
    ALTER COLUMN expires_at SET DEFAULT (clock_timestamp() + interval '15 minutes');
ALTER TABLE held_request ADD COLUMN action_request_id uuid REFERENCES action_request(id),
    ADD COLUMN payload_hash text GENERATED ALWAYS AS (app.payload_sha256(payload)) STORED,
    ADD COLUMN rejection_reason text;
CREATE INDEX idx_tool_policy_registry ON guardrail_policy (org_id, simulated, (config->>'aiSystemCode'))
    WHERE config->>'kind' = 'tool-call';
CREATE UNIQUE INDEX uq_held_action_request ON held_request(action_request_id);
CREATE INDEX idx_action_request_expiry ON action_request(org_id, expires_at)
    WHERE status IN ('open', 'in_review', 'awaiting_second', 'approved');
CREATE TABLE action_check_result (
    org_id text NOT NULL,
    actor text NOT NULL,
    operation text NOT NULL CHECK (operation IN ('create', 'check')),
    key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    result jsonb NOT NULL,
    action_request_id uuid REFERENCES action_request(id),
    simulated boolean NOT NULL,
    classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, actor, operation, key_hash)
);
CREATE TABLE action_escalation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    action_request_id uuid NOT NULL UNIQUE REFERENCES action_request(id),
    reason text NOT NULL,
    recipient_role text NOT NULL DEFAULT 'fieldloop.manager',
    simulated boolean NOT NULL,
    classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Link the exact L2 payload to its Action Request; no hold can authorize a different payload.
CREATE FUNCTION guard_held_action() RETURNS trigger AS $$
DECLARE parent app.action_request%ROWTYPE;
BEGIN
    IF NEW.status IN ('held', 'allowed') AND (NEW.expires_at IS NULL OR NEW.expires_at <= clock_timestamp()) THEN
        RAISE EXCEPTION 'Expired Held Request cannot be held or allowed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.action_request_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO STRICT parent FROM app.action_request WHERE id = NEW.action_request_id FOR SHARE;
    IF NOT EXISTS (SELECT 1 FROM app.intercept WHERE id = NEW.intercept_id AND org_id = NEW.org_id
        AND simulated = NEW.simulated AND classification = NEW.classification)
        OR (NEW.status IN ('held', 'allowed') AND parent.simulation_retired_at IS NOT NULL)
        OR (NEW.status = 'allowed' AND parent.status <> 'approved') THEN
        RAISE EXCEPTION 'Held Request Intercept, lifecycle or approval scope invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF parent.org_id <> NEW.org_id OR parent.simulated <> NEW.simulated
        OR parent.classification IS DISTINCT FROM NEW.classification
        OR parent.action_level <> 'l2' OR (NEW.status <> 'rejected' AND parent.payload IS DISTINCT FROM NEW.payload)
        OR parent.expires_at IS DISTINCT FROM NEW.expires_at THEN
        RAISE EXCEPTION 'Held Request scope or payload differs from Action Request' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;
CREATE TRIGGER guard_held_action BEFORE INSERT OR UPDATE ON held_request
FOR EACH ROW EXECUTE FUNCTION guard_held_action();

GRANT SELECT, INSERT ON action_check_result, action_escalation TO fieldloop_app;
GRANT SELECT ON action_ceiling TO fieldloop_app;
DO $$
DECLARE environment text; role_name text;
BEGIN
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN RETURN; END IF;
    environment := replace(current_database(), 'fieldloop_', '');
    FOREACH role_name IN ARRAY ARRAY['fieldloop_app_' || environment, 'fieldloop_guardrail_' || environment] LOOP
        EXECUTE format('GRANT SELECT ON app.action_ceiling, app.action_check_result, app.action_escalation, app.current_action_request, app.action_request, app.held_request, app.audit_event TO %I', role_name);
        EXECUTE format('GRANT INSERT ON app.notification, app.action_check_result, app.action_escalation, app.action_request, app.held_request, app.audit_event TO %I', role_name);
        EXECUTE format('GRANT UPDATE (status, rejection_reason) ON app.action_request, app.held_request TO %I', role_name);
    END LOOP;
    role_name := 'fl-v2-signal-worker-' || environment || '@example-project.iam';
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('GRANT SELECT ON app.action_request, app.held_request, app.action_escalation TO %I', role_name);
        EXECUTE format('GRANT UPDATE (status, rejection_reason) ON app.action_request, app.held_request TO %I', role_name);
        EXECUTE format('GRANT INSERT ON app.action_escalation, app.notification TO %I', role_name);
    END IF;
END $$;

-- A payload edit voids the held authorization together with T04's Approval invalidation.
CREATE FUNCTION void_changed_action_hold() RETURNS trigger AS $$
BEGIN
    IF NEW.payload IS DISTINCT FROM OLD.payload THEN
        UPDATE app.held_request SET status = 'rejected', rejection_reason = 'payload_changed'
        WHERE action_request_id = NEW.id AND status IN ('held', 'allowed');
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;
CREATE TRIGGER void_changed_action_hold AFTER UPDATE OF payload ON action_request
FOR EACH ROW EXECUTE FUNCTION void_changed_action_hold();

-- Effect-bearing metadata cannot be rebound while keeping the same exact-payload approval.
CREATE FUNCTION guard_action_envelope() RETURNS trigger AS $$
BEGIN
    IF (NEW.org_id, NEW.action_type, NEW.action_level, NEW.target, NEW.requested_by, NEW.simulated, NEW.classification)
        IS DISTINCT FROM (OLD.org_id, OLD.action_type, OLD.action_level, OLD.target, OLD.requested_by, OLD.simulated, OLD.classification) THEN
        RAISE EXCEPTION 'Action identity, target and Action Level are immutable; propose a new request' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = app, pg_temp;
CREATE TRIGGER guard_action_envelope BEFORE UPDATE ON action_request
FOR EACH ROW EXECUTE FUNCTION guard_action_envelope();

-- Deadline checks complement the service/Scheduler rejection; an expired record cannot execute.
CREATE FUNCTION guard_action_deadline() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.expires_at IS NOT NULL
        AND (NEW.expires_at IS NULL OR NEW.expires_at > OLD.expires_at) THEN
        RAISE EXCEPTION 'Action SLA cannot be extended' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('approved', 'executed') AND (NEW.expires_at IS NULL OR NEW.expires_at <= clock_timestamp()) THEN
        RAISE EXCEPTION 'Expired Action Request cannot be approved or executed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = app, pg_temp;
CREATE TRIGGER zz_guard_action_deadline BEFORE INSERT OR UPDATE ON action_request
FOR EACH ROW EXECUTE FUNCTION guard_action_deadline();

-- migrate:down
DROP TRIGGER guard_action_envelope ON app.action_request;
DROP FUNCTION app.guard_action_envelope();
DROP TRIGGER zz_guard_action_deadline ON app.action_request;
DROP FUNCTION app.guard_action_deadline();
DO $$
DECLARE environment text; role_name text;
BEGIN
    IF current_database() NOT IN ('fieldloop_dev', 'fieldloop_demo') THEN RETURN; END IF;
    environment := replace(current_database(), 'fieldloop_', '');
    role_name := 'fieldloop_guardrail_' || environment;
    EXECUTE format('REVOKE ALL ON app.current_action_request, app.action_request, app.held_request, app.audit_event FROM %I', role_name);
    EXECUTE format('REVOKE INSERT ON app.notification FROM %I', role_name);
    role_name := 'fl-v2-signal-worker-' || environment || '@example-project.iam';
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE SELECT ON app.action_request, app.held_request FROM %I', role_name);
        EXECUTE format('REVOKE UPDATE (status, rejection_reason) ON app.action_request, app.held_request FROM %I', role_name);
    END IF;
END $$;
DROP TRIGGER void_changed_action_hold ON app.action_request;
DROP FUNCTION app.void_changed_action_hold();
SET search_path = app, public;
DROP TABLE action_escalation;
DROP TABLE action_check_result;
DROP TRIGGER guard_held_action ON held_request;
DROP FUNCTION guard_held_action();
DROP INDEX idx_tool_policy_registry;
DROP INDEX idx_action_request_expiry;
DROP INDEX uq_held_action_request;
ALTER TABLE held_request DROP COLUMN action_request_id, DROP COLUMN payload_hash, DROP COLUMN rejection_reason;
ALTER TABLE action_request DROP COLUMN target, DROP COLUMN rejection_reason, ALTER COLUMN expires_at DROP DEFAULT;
DROP TABLE action_ceiling;
