-- migrate:up
SET search_path = app, public;
-- FL-96: an Approver's decision is a consequential command, so it is replayable by Idempotency-Key
-- exactly like create and check. The result stores only the Approval id; a replay re-reads the
-- current Action Request.
ALTER TABLE action_check_result DROP CONSTRAINT action_check_result_operation_check,
    ADD CONSTRAINT action_check_result_operation_check CHECK (operation IN ('create', 'check', 'approve', 'reject'));

-- migrate:down
SET search_path = app, public;
DELETE FROM action_check_result WHERE operation IN ('approve', 'reject');
ALTER TABLE action_check_result DROP CONSTRAINT action_check_result_operation_check,
    ADD CONSTRAINT action_check_result_operation_check CHECK (operation IN ('create', 'check'));
