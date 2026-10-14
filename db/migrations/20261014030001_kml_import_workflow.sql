-- migrate:up
SET search_path = app, public;
ALTER TABLE kml_import ADD COLUMN preview jsonb, ADD COLUMN version integer NOT NULL DEFAULT 1,
    ADD COLUMN request_key text, ADD COLUMN commit_key text, ADD COLUMN rollback_key text,
    ADD COLUMN validation_hash text;
CREATE UNIQUE INDEX idx_kml_import_request ON kml_import (org_id, created_by, request_key);
CREATE INDEX idx_segment_import_asset ON segment (org_id, asset_id);
CREATE INDEX idx_kml_import_item_batch ON kml_import_item (org_id, kml_import_id);
ALTER TABLE kml_import_item ADD COLUMN attributes jsonb, ADD COLUMN target_id uuid,
    ADD COLUMN asset_id uuid REFERENCES asset(id), ADD COLUMN flags jsonb;
ALTER TABLE organisation ADD COLUMN import_area geometry(MultiPolygon, 4326);
CREATE INDEX idx_organisation_import_area ON organisation USING GIST (import_area);

-- migrate:down
SET search_path = app, public;
DROP INDEX idx_organisation_import_area;
ALTER TABLE organisation DROP COLUMN import_area;
ALTER TABLE kml_import_item DROP COLUMN flags, DROP COLUMN asset_id, DROP COLUMN target_id, DROP COLUMN attributes;
DROP INDEX idx_kml_import_request;
DROP INDEX idx_kml_import_item_batch;
DROP INDEX idx_segment_import_asset;
ALTER TABLE kml_import DROP COLUMN rollback_key, DROP COLUMN commit_key, DROP COLUMN request_key,
    DROP COLUMN version, DROP COLUMN preview, DROP COLUMN validation_hash;
