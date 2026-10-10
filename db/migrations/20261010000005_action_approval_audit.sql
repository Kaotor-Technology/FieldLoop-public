-- migrate:up
SET search_path = app, public;
CREATE TABLE action_request (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    action_type text NOT NULL,
    action_level text NOT NULL,
    payload jsonb,
    payload_hash text NOT NULL,
    rationale text,
    citations jsonb,
    requested_by text,
    status text NOT NULL,
    expires_at timestamptz,
    asset_id uuid REFERENCES asset(id),
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE approval (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    action_request_id uuid NOT NULL REFERENCES action_request(id),
    approver_sub text NOT NULL,
    decision text NOT NULL,
    reason text,
    payload_hash text NOT NULL,
    auth_time timestamptz NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

-- Trigger to ensure payload_hash matches, and reset status to open if payload changes
CREATE OR REPLACE FUNCTION check_approval_payload_hash()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.payload_hash != (SELECT payload_hash FROM action_request WHERE id = NEW.action_request_id) THEN
        RAISE EXCEPTION 'Payload hash mismatch';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_approval_payload_hash
BEFORE INSERT OR UPDATE ON approval
FOR EACH ROW
EXECUTE FUNCTION check_approval_payload_hash();

CREATE OR REPLACE FUNCTION reset_action_request_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.payload IS DISTINCT FROM OLD.payload THEN
        NEW.status := 'open';
        -- Optional: you might want to recalculate payload_hash here or require client to update it
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reset_action_request_status
BEFORE UPDATE ON action_request
FOR EACH ROW
EXECUTE FUNCTION reset_action_request_status();

CREATE TABLE command_package (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    action_request_id uuid NOT NULL REFERENCES action_request(id),
    target text NOT NULL,
    preconditions jsonb,
    outcome text,
    executed_by text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE notification (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    action_request_id uuid NOT NULL REFERENCES action_request(id),
    channel text NOT NULL,
    recipient_ref text NOT NULL,
    status text NOT NULL,
    receipt jsonb,
    sandbox boolean NOT NULL DEFAULT false,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE audit_event (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    entity text NOT NULL,
    before_hash text,
    after_hash text,
    prev_hash text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

-- Revoke UPDATE and DELETE from audit_event
REVOKE UPDATE, DELETE ON audit_event FROM fieldloop_app;
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_event is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_audit_modification
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_modification();

-- migrate:down
SET search_path = app, public;
DROP TRIGGER trg_prevent_audit_modification ON audit_event;
DROP FUNCTION prevent_audit_modification;
DROP TABLE audit_event;
DROP TABLE notification;
DROP TABLE command_package;
DROP TRIGGER trg_check_approval_payload_hash ON approval;
DROP FUNCTION check_approval_payload_hash;
DROP TRIGGER trg_reset_action_request_status ON action_request;
DROP FUNCTION reset_action_request_status;
DROP TABLE approval;
DROP TABLE action_request;
