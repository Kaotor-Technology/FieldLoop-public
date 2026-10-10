-- migrate:up
SET search_path = app, public;
CREATE TABLE action_request (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    action_type text NOT NULL,
    action_level text NOT NULL,
    payload jsonb NOT NULL,
    -- Derived, never client-supplied, so the hash cannot drift from the payload (PRD AX-2).
    payload_hash text NOT NULL GENERATED ALWAYS AS (encode(public.digest(payload::text, 'sha256'), 'hex')) STORED,
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
    voided_at timestamptz,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

-- Exact-payload approvals (PRD AX-2): an Approval is accepted only for the payload hash the
-- Action Request has right now. Table names are schema-qualified because trigger functions run
-- with the caller's search_path.
CREATE FUNCTION check_approval_payload_hash()
RETURNS TRIGGER AS $$
DECLARE
    current_hash text;
BEGIN
    -- Lock the request so a concurrent payload change cannot slip past this check.
    SELECT payload_hash INTO current_hash
    FROM app.action_request
    WHERE id = NEW.action_request_id
    FOR SHARE;

    IF NEW.payload_hash IS DISTINCT FROM current_hash THEN
        RAISE EXCEPTION 'approval.payload_hash does not match action_request %', NEW.action_request_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'approval cannot be created already voided'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_approval_payload_hash
BEFORE INSERT ON approval
FOR EACH ROW
EXECUTE FUNCTION check_approval_payload_hash();

-- An Approval is immutable once recorded; the only permitted change is voiding it.
CREATE FUNCTION guard_approval_update()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.voided_at IS NOT NULL
        OR NEW.voided_at IS NULL
        OR (to_jsonb(NEW) - 'voided_at') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at') THEN
        RAISE EXCEPTION 'approval is immutable; it can only be voided'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_approval_update
BEFORE UPDATE ON approval
FOR EACH ROW
EXECUTE FUNCTION guard_approval_update();

-- Any payload change reopens the request and voids its Approvals, so an earlier Approval never
-- becomes valid again, even if the payload is later changed back.
CREATE FUNCTION reset_action_request_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.payload IS DISTINCT FROM OLD.payload THEN
        NEW.status := 'open';
        UPDATE app.approval
        SET voided_at = now()
        WHERE action_request_id = OLD.id AND voided_at IS NULL;
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
DROP TRIGGER trg_guard_approval_update ON approval;
DROP FUNCTION guard_approval_update;
DROP TRIGGER trg_check_approval_payload_hash ON approval;
DROP FUNCTION check_approval_payload_hash;
DROP TRIGGER trg_reset_action_request_status ON action_request;
DROP FUNCTION reset_action_request_status;
DROP TABLE approval;
DROP TABLE action_request;
