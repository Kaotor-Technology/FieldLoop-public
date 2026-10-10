-- migrate:up
SET search_path = app, public;

-- Bowtie A is authored as a readable synthetic fixture and these fields keep its
-- display names and Performance Standards in the normalized records.
ALTER TABLE app.threat
    ADD COLUMN name text;

ALTER TABLE app.consequence
    ADD COLUMN name text;

ALTER TABLE app.barrier
    ADD COLUMN name text,
    ADD COLUMN performance_standard text;

-- migrate:down
SET search_path = app, public;
ALTER TABLE app.barrier
    DROP COLUMN performance_standard,
    DROP COLUMN name;
ALTER TABLE app.consequence DROP COLUMN name;
ALTER TABLE app.threat DROP COLUMN name;
