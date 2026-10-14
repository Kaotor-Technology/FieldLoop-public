-- migrate:up
SET search_path = app, public;

-- PRD AX-1: record who requested the action. A person raises it directly; an assistant raises it
-- through a converted or held tool call, on behalf of the session user in requested_by.
ALTER TABLE action_request
    ADD COLUMN requester_kind text NOT NULL DEFAULT 'person' CHECK (requester_kind IN ('person', 'assistant')),
    ADD COLUMN requester_ai_system_id uuid REFERENCES ai_system(id),
    ADD CONSTRAINT action_request_requester_check CHECK (
        (requester_kind = 'person' AND requester_ai_system_id IS NULL)
        OR (requester_kind = 'assistant' AND requester_ai_system_id IS NOT NULL));

-- The requester is effect-bearing identity, so it is immutable like the rest of the envelope.
CREATE OR REPLACE FUNCTION guard_action_envelope() RETURNS trigger AS $$
BEGIN
    IF (NEW.org_id, NEW.action_type, NEW.action_level, NEW.target, NEW.requested_by, NEW.requester_kind,
        NEW.requester_ai_system_id, NEW.simulated, NEW.classification)
        IS DISTINCT FROM (OLD.org_id, OLD.action_type, OLD.action_level, OLD.target, OLD.requested_by, OLD.requester_kind,
        OLD.requester_ai_system_id, OLD.simulated, OLD.classification) THEN
        RAISE EXCEPTION 'Action identity, target and Action Level are immutable; propose a new request' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = app, pg_temp;

-- An assistant requester must be an AI System registered in the same Organisation and simulation scope.
CREATE FUNCTION guard_action_requester() RETURNS trigger AS $$
BEGIN
    IF NEW.requester_ai_system_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.ai_system
        WHERE id = NEW.requester_ai_system_id AND org_id = NEW.org_id AND simulated = NEW.simulated) THEN
        RAISE EXCEPTION 'Action requester AI System is outside the request scope' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp;
CREATE TRIGGER guard_action_requester BEFORE INSERT ON action_request
FOR EACH ROW EXECUTE FUNCTION guard_action_requester();

-- migrate:down
SET search_path = app, public;
DROP TRIGGER guard_action_requester ON action_request;
DROP FUNCTION guard_action_requester();
CREATE OR REPLACE FUNCTION guard_action_envelope() RETURNS trigger AS $$
BEGIN
    IF (NEW.org_id, NEW.action_type, NEW.action_level, NEW.target, NEW.requested_by, NEW.simulated, NEW.classification)
        IS DISTINCT FROM (OLD.org_id, OLD.action_type, OLD.action_level, OLD.target, OLD.requested_by, OLD.simulated, OLD.classification) THEN
        RAISE EXCEPTION 'Action identity, target and Action Level are immutable; propose a new request' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = app, pg_temp;
ALTER TABLE action_request DROP CONSTRAINT action_request_requester_check,
    DROP COLUMN requester_ai_system_id, DROP COLUMN requester_kind;
