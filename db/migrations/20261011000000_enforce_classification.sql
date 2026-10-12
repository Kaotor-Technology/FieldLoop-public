-- migrate:up
SET search_path = app, public;
-- Every table with a classification column must state it, from the PRD 9.1 classes, and must
-- state simulated; neither has a default, so a writer cannot leave them out by accident.
-- Partitions inherit the rules from their parent.
DO $$
DECLARE
    labelled record;
BEGIN
    FOR labelled IN
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'classification' AND NOT a.attisdropped
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname
    LOOP
        EXECUTE format('UPDATE app.%I SET classification = upper(classification) WHERE classification <> upper(classification)', labelled.table_name);
        EXECUTE format('ALTER TABLE app.%I ALTER COLUMN classification DROP DEFAULT', labelled.table_name);
        EXECUTE format('ALTER TABLE app.%I ALTER COLUMN classification SET NOT NULL', labelled.table_name);
        EXECUTE format('ALTER TABLE app.%I ALTER COLUMN simulated DROP DEFAULT', labelled.table_name);
        EXECUTE format(
            'ALTER TABLE app.%I ADD CONSTRAINT %I CHECK (classification IN (''PUBLIC'', ''INTERNAL'', ''CONFIDENTIAL'', ''HIGHLY_RESTRICTED''))',
            labelled.table_name, labelled.table_name || '_classification_check');
    END LOOP;
END $$;

-- migrate:down
SET search_path = app, public;
DO $$
DECLARE
    labelled record;
BEGIN
    FOR labelled IN
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'classification' AND NOT a.attisdropped
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname
    LOOP
        EXECUTE format('ALTER TABLE app.%I DROP CONSTRAINT %I', labelled.table_name, labelled.table_name || '_classification_check');
        EXECUTE format('ALTER TABLE app.%I ALTER COLUMN simulated SET DEFAULT false', labelled.table_name);
        EXECUTE format('ALTER TABLE app.%I ALTER COLUMN classification DROP NOT NULL', labelled.table_name);
    END LOOP;
END $$;
-- The BFF login table declared its classification NOT NULL with a default (migration 9).
ALTER TABLE oidc_login_transaction ALTER COLUMN classification SET NOT NULL;
ALTER TABLE oidc_login_transaction ALTER COLUMN classification SET DEFAULT 'INTERNAL';
