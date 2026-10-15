-- migrate:up
SET search_path = app, public;

ALTER TABLE geo_reference
    ALTER COLUMN evidence_id DROP NOT NULL,
    ALTER COLUMN target_type DROP NOT NULL,
    ALTER COLUMN target_id DROP NOT NULL,
    ADD COLUMN source_document_id uuid,
    ADD COLUMN source_snippet text,
    ADD COLUMN proposed_label text,
    ADD COLUMN extraction_key text,
    ADD COLUMN extraction_hash text,
    ADD COLUMN decided_by text,
    ADD COLUMN decision_key text,
    ADD COLUMN decision_hash text,
    ADD CONSTRAINT geo_reference_document_org_fk
        FOREIGN KEY (org_id, source_document_id)
        REFERENCES controlled_document (org_id, id),
    ADD CONSTRAINT geo_reference_source_check
        CHECK (num_nonnulls(evidence_id, source_document_id) = 1),
    ADD CONSTRAINT geo_reference_target_pair_check
        CHECK (num_nonnulls(target_type, target_id) IN (0, 2)),
    ADD CONSTRAINT geo_reference_status_check
        CHECK (status IS NULL OR status IN ('draft', 'confirmed', 'rejected', 'imported', 'reviewed')),
    ADD CONSTRAINT geo_reference_kind_check
        CHECK (kind IN ('point', 'chainage', 'area', 'asset'));

CREATE INDEX idx_geo_reference_document_status
    ON geo_reference (org_id, source_document_id, status, created_at DESC);
CREATE UNIQUE INDEX uq_geo_reference_extraction_key
    ON geo_reference (org_id, source_document_id, extraction_key)
    WHERE source_document_id IS NOT NULL AND extraction_key IS NOT NULL;
CREATE UNIQUE INDEX uq_geo_reference_decision_key
    ON geo_reference (org_id, decided_by, decision_key)
    WHERE decided_by IS NOT NULL AND decision_key IS NOT NULL;

-- migrate:down
SET search_path = app, public;

DROP INDEX uq_geo_reference_extraction_key;
DROP INDEX uq_geo_reference_decision_key;
DROP INDEX idx_geo_reference_document_status;
ALTER TABLE geo_reference
    DROP CONSTRAINT geo_reference_kind_check,
    DROP CONSTRAINT geo_reference_status_check,
    DROP CONSTRAINT geo_reference_target_pair_check,
    DROP CONSTRAINT geo_reference_source_check,
    DROP CONSTRAINT geo_reference_document_org_fk,
    DROP COLUMN decision_hash,
    DROP COLUMN decision_key,
    DROP COLUMN decided_by,
    DROP COLUMN extraction_key,
    DROP COLUMN extraction_hash,
    DROP COLUMN proposed_label,
    DROP COLUMN source_snippet,
    DROP COLUMN source_document_id,
    ALTER COLUMN target_id SET NOT NULL,
    ALTER COLUMN target_type SET NOT NULL,
    ALTER COLUMN evidence_id SET NOT NULL;
