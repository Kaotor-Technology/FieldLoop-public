-- migrate:up
SET search_path = app, public;

ALTER TABLE risk_snapshot ADD COLUMN input_fingerprint text;
CREATE UNIQUE INDEX uq_risk_snapshot_current_input
    ON risk_snapshot (org_id, bowtie_id, input_fingerprint)
    WHERE health_change_id IS NULL AND input_fingerprint IS NOT NULL AND simulation_retired_at IS NULL;

-- migrate:down
SET search_path = app, public;
DROP INDEX uq_risk_snapshot_current_input;
ALTER TABLE risk_snapshot DROP COLUMN input_fingerprint;
