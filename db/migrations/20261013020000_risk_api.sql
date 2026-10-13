-- migrate:up
SET search_path = app, public;

-- A matrix is usable only after the Organisation's Technical Authority has
-- approved it. Existing demo Organisations intentionally remain unconfigured.
ALTER TABLE organisation
    ADD COLUMN risk_matrix jsonb,
    ADD COLUMN risk_severity_criteria jsonb,
    ADD COLUMN risk_matrix_approved_at timestamptz,
    ADD COLUMN risk_matrix_approved_by text,
    ADD CONSTRAINT organisation_risk_matrix_approval_pair CHECK (
        (risk_matrix IS NULL AND risk_severity_criteria IS NULL AND risk_matrix_approved_at IS NULL AND risk_matrix_approved_by IS NULL)
        OR (risk_matrix IS NOT NULL AND risk_severity_criteria IS NOT NULL AND risk_matrix_approved_at IS NOT NULL AND risk_matrix_approved_by IS NOT NULL)
    );
COMMENT ON COLUMN organisation.risk_matrix IS 'Organisation-approved 5x5 RiskMatrix JSON: four annual frequency thresholds and 25 zone/rank cells.';
COMMENT ON COLUMN organisation.risk_severity_criteria IS 'Organisation-approved 1–5 descriptors for people, environment, financial, serviceContinuity, reputation and legalRegulatory.';
COMMENT ON COLUMN organisation.risk_matrix_approved_by IS 'Technical Authority subject identifier that approved both risk_matrix and risk_severity_criteria.';

ALTER TABLE risk_snapshot
    ADD COLUMN snapshot_json jsonb,
    ADD COLUMN input_json jsonb,
    ADD COLUMN health_change_id uuid REFERENCES health_change(id);

CREATE UNIQUE INDEX uq_risk_snapshot_health_change
    ON risk_snapshot (org_id, bowtie_id, health_change_id)
    WHERE health_change_id IS NOT NULL;
CREATE INDEX idx_risk_snapshot_latest
    ON risk_snapshot (org_id, bowtie_id, created_at DESC, id DESC)
    WHERE simulation_retired_at IS NULL;

-- migrate:down
SET search_path = app, public;
DROP INDEX idx_risk_snapshot_latest;
DROP INDEX uq_risk_snapshot_health_change;
ALTER TABLE risk_snapshot DROP COLUMN health_change_id, DROP COLUMN input_json, DROP COLUMN snapshot_json;
ALTER TABLE organisation DROP CONSTRAINT organisation_risk_matrix_approval_pair,
    DROP COLUMN risk_matrix_approved_by,
    DROP COLUMN risk_matrix_approved_at,
    DROP COLUMN risk_severity_criteria,
    DROP COLUMN risk_matrix;
