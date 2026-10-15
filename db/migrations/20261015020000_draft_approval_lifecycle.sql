-- migrate:up
SET search_path = app, public;

ALTER TABLE draft
    ADD COLUMN approved_by_sub text,
    ADD COLUMN approved_at timestamptz,
    ADD COLUMN approved_auth_time timestamptz,
    ADD COLUMN approved_content_hash text,
    ADD COLUMN decision_by_sub text,
    ADD COLUMN decision_by_name text,
    ADD COLUMN decision_at timestamptz,
    ADD COLUMN decision_auth_time timestamptz,
    ADD COLUMN decision_reason text,
    ADD COLUMN decision_key text,
    ADD COLUMN decision_hash text;

CREATE UNIQUE INDEX idx_draft_org_decision_key
    ON draft (org_id, decision_key) WHERE decision_key IS NOT NULL;

CREATE FUNCTION guard_draft_human_decision() RETURNS trigger AS $$
DECLARE
    author_sub text;
BEGIN
    IF OLD.status <> 'needs_approval' OR NEW.status NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Only a pending Draft can receive one human decision' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
        OR NEW.assistant_session_id IS DISTINCT FROM OLD.assistant_session_id
        OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.content IS DISTINCT FROM OLD.content
        OR NEW.citations IS DISTINCT FROM OLD.citations OR NEW.confidence IS DISTINCT FROM OLD.confidence
        OR NEW.simulated IS DISTINCT FROM OLD.simulated OR NEW.classification IS DISTINCT FROM OLD.classification
        OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'Draft content and source citations are immutable during approval' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.decision_by_sub IS NULL OR NEW.decision_by_sub LIKE 'agent:%'
        OR NEW.decision_by_name IS NULL OR btrim(NEW.decision_by_name) = ''
        OR NEW.decision_at IS NULL OR NEW.decision_auth_time IS NULL
        OR NEW.decision_auth_time < clock_timestamp() - interval '5 minutes'
        OR NEW.decision_auth_time > clock_timestamp() + interval '30 seconds'
        OR COALESCE(NEW.decision_key, '') !~ '^[a-f0-9]{64}$'
        OR COALESCE(NEW.decision_hash, '') !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'A Draft decision requires a named, authenticated person' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status = 'approved' THEN
        author_sub := substring(OLD.created_by FROM 'on_behalf_of:([^[:space:]]+)');
        IF author_sub IS NULL AND COALESCE(OLD.created_by, '') NOT LIKE 'agent:%' THEN
            author_sub := OLD.created_by;
        END IF;
        IF author_sub IS NULL OR author_sub = NEW.decision_by_sub THEN
            RAISE EXCEPTION 'The Draft author cannot approve their Draft' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.approved_by IS DISTINCT FROM NEW.decision_by_name
            OR NEW.approved_by_sub IS DISTINCT FROM NEW.decision_by_sub
            OR NEW.approved_at IS DISTINCT FROM NEW.decision_at
            OR NEW.approved_auth_time IS DISTINCT FROM NEW.decision_auth_time
            OR COALESCE(NEW.approved_content_hash, '') !~ '^[a-f0-9]{64}$'
            OR NEW.decision_reason IS NOT NULL THEN
            RAISE EXCEPTION 'Approved Draft metadata is incomplete or inconsistent' USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        IF NEW.approved_by IS NOT NULL OR NEW.approved_by_sub IS NOT NULL OR NEW.approved_at IS NOT NULL
            OR NEW.approved_auth_time IS NOT NULL OR NEW.approved_content_hash IS NOT NULL
            OR NEW.decision_reason IS NULL OR btrim(NEW.decision_reason) = '' THEN
            RAISE EXCEPTION 'Rejected Draft metadata is incomplete or inconsistent' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = app, pg_temp;

CREATE TRIGGER trg_guard_draft_human_decision
BEFORE UPDATE ON draft
FOR EACH ROW EXECUTE FUNCTION guard_draft_human_decision();

-- migrate:down
SET search_path = app, public;
DROP TRIGGER trg_guard_draft_human_decision ON draft;
DROP FUNCTION guard_draft_human_decision();
DROP INDEX idx_draft_org_decision_key;
ALTER TABLE draft
    DROP COLUMN decision_hash,
    DROP COLUMN decision_key,
    DROP COLUMN decision_reason,
    DROP COLUMN decision_auth_time,
    DROP COLUMN decision_at,
    DROP COLUMN decision_by_name,
    DROP COLUMN decision_by_sub,
    DROP COLUMN approved_content_hash,
    DROP COLUMN approved_auth_time,
    DROP COLUMN approved_at,
    DROP COLUMN approved_by_sub;
