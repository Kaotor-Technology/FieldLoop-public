-- migrate:up
SET search_path = app, public;

-- Every approved Organisation calibration must identify the controlled source
-- and edition that defines its frequency bands, consequence criteria and zones.
ALTER TABLE organisation
    DROP CONSTRAINT organisation_risk_matrix_approval_pair,
    ADD COLUMN risk_matrix_standard_ref text,
    ADD COLUMN risk_matrix_standard_version text,
    ADD CONSTRAINT organisation_risk_matrix_provenance CHECK (
        (risk_matrix IS NULL AND risk_severity_criteria IS NULL
            AND risk_matrix_approved_at IS NULL AND risk_matrix_approved_by IS NULL
            AND risk_matrix_standard_ref IS NULL AND risk_matrix_standard_version IS NULL)
        OR (risk_matrix IS NOT NULL AND risk_severity_criteria IS NOT NULL
            AND risk_matrix_approved_at IS NOT NULL
            AND NULLIF(btrim(risk_matrix_approved_by), '') IS NOT NULL
            AND NULLIF(btrim(risk_matrix_standard_ref), '') IS NOT NULL
            AND NULLIF(btrim(risk_matrix_standard_version), '') IS NOT NULL)
    );

COMMENT ON COLUMN organisation.risk_matrix_standard_ref IS 'Controlled Organisation standard reference and clause used for Risk Matrix calibration.';
COMMENT ON COLUMN organisation.risk_matrix_standard_version IS 'Edition or revision of the controlled Organisation standard used for Risk Matrix calibration.';

-- migrate:down
SET search_path = app, public;
ALTER TABLE organisation DROP CONSTRAINT organisation_risk_matrix_provenance,
    DROP COLUMN risk_matrix_standard_version,
    DROP COLUMN risk_matrix_standard_ref;
ALTER TABLE organisation ADD CONSTRAINT organisation_risk_matrix_approval_pair CHECK (
    (risk_matrix IS NULL AND risk_severity_criteria IS NULL AND risk_matrix_approved_at IS NULL AND risk_matrix_approved_by IS NULL)
    OR (risk_matrix IS NOT NULL AND risk_severity_criteria IS NOT NULL AND risk_matrix_approved_at IS NOT NULL AND risk_matrix_approved_by IS NOT NULL)
);
