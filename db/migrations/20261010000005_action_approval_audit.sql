-- migrate:up
SET search_path = app, public;
-- SHA-256 of the canonical jsonb text. convert_to is only STABLE because it takes an encoding
-- name; with the encoding fixed to UTF8 the result is immutable.
CREATE FUNCTION payload_sha256(payload jsonb)
RETURNS text AS $$
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::text, 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

CREATE TABLE action_request (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    action_type text NOT NULL,
    action_level text NOT NULL CHECK (action_level IN ('l0', 'l1', 'l2')),
    payload jsonb NOT NULL,
    -- Derived, never client-supplied, so the hash cannot drift from the payload (PRD AX-2).
    payload_hash text NOT NULL GENERATED ALWAYS AS (app.payload_sha256(payload)) STORED,
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
    decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
    reason text,
    payload_hash text NOT NULL,
    auth_time timestamptz NOT NULL,
    voided_at timestamptz,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);
-- An Approver decides once per payload; two-person approval needs two different people (PRD AX-3).
CREATE UNIQUE INDEX idx_approval_one_per_approver ON approval (action_request_id, approver_sub)
WHERE voided_at IS NULL;

-- Exact-payload approvals (PRD AX-2). The trigger functions are SECURITY DEFINER with a fixed
-- search_path: they work for any caller without that caller holding UPDATE on approval, which
-- would let it void or alter Approvals directly.

-- An Approval is accepted only for the payload hash the Action Request has right now.
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;

CREATE TRIGGER trg_check_approval_payload_hash
BEFORE INSERT ON approval
FOR EACH ROW
EXECUTE FUNCTION check_approval_payload_hash();

-- An Approval is immutable once recorded: it cannot be deleted, and the only permitted change
-- is voiding it.
CREATE FUNCTION guard_approval_modification()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.voided_at IS NULL
            AND NEW.voided_at IS NOT NULL
            AND (to_jsonb(NEW) - 'voided_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'voided_at') THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'approval is immutable; it can only be voided'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_approval_modification
BEFORE UPDATE OR DELETE ON approval
FOR EACH ROW
EXECUTE FUNCTION guard_approval_modification();

CREATE TRIGGER trg_guard_approval_truncate
BEFORE TRUNCATE ON approval
FOR EACH STATEMENT
EXECUTE FUNCTION guard_approval_modification();

-- Any payload change reopens the request and voids its Approvals, so an earlier Approval never
-- becomes valid again, even if the payload is later changed back. A request can be 'approved'
-- only while it has an Approval that is not voided, says 'approved' and is for this payload;
-- how many Approvers an action type needs (PRD AX-3) is decided by the service.
CREATE FUNCTION guard_action_request_approval()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'approved' THEN
            RAISE EXCEPTION 'action_request cannot be created already approved'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSIF NEW.payload IS DISTINCT FROM OLD.payload THEN
        NEW.status := 'open';
        UPDATE app.approval
        SET voided_at = now()
        WHERE action_request_id = OLD.id AND voided_at IS NULL;
    ELSIF NEW.status = 'approved' AND NOT EXISTS (
        SELECT 1
        FROM app.approval
        WHERE action_request_id = OLD.id
            AND voided_at IS NULL
            AND decision = 'approved'
            AND payload_hash = OLD.payload_hash) THEN
        RAISE EXCEPTION 'action_request % has no valid approval for its payload', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;

CREATE TRIGGER trg_guard_action_request_approval
BEFORE INSERT OR UPDATE ON action_request
FOR EACH ROW
EXECUTE FUNCTION guard_action_request_approval();

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
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

-- audit_event is append-only: the app role never gets UPDATE or DELETE, and the triggers hold
-- for every role.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM fieldloop_app;
CREATE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_event is append-only'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_audit_modification
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_modification();

CREATE TRIGGER trg_prevent_audit_truncate
BEFORE TRUNCATE ON audit_event
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_audit_modification();

-- migrate:down
SET search_path = app, public;
DROP TABLE audit_event;
DROP FUNCTION prevent_audit_modification;
DROP TABLE notification;
DROP TABLE command_package;
DROP TABLE approval;
DROP TABLE action_request;
DROP FUNCTION guard_action_request_approval;
DROP FUNCTION guard_approval_modification;
DROP FUNCTION check_approval_payload_hash;
DROP FUNCTION payload_sha256;
