-- Every table in app with a classification column states it from the PRD 9.1 classes and
-- states simulated, with no default for either. A new table must follow the same rules.
DO $$
DECLARE
    unruly text;
BEGIN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unruly
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute classification
      ON classification.attrelid = c.oid AND classification.attname = 'classification' AND NOT classification.attisdropped
    LEFT JOIN pg_attribute simulated
      ON simulated.attrelid = c.oid AND simulated.attname = 'simulated' AND NOT simulated.attisdropped
    WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
      AND (NOT classification.attnotnull
           OR classification.atthasdef
           OR simulated.attnum IS NULL
           OR NOT simulated.attnotnull
           OR simulated.atthasdef
           OR NOT EXISTS (
               SELECT 1 FROM pg_constraint k
               WHERE k.conrelid = c.oid AND k.contype = 'c'
                 AND pg_get_constraintdef(k.oid) LIKE '%classification%HIGHLY_RESTRICTED%'));
    IF unruly IS NOT NULL THEN
        RAISE EXCEPTION 'tables that do not enforce simulated and classification: %', unruly;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND a.attname = 'classification') THEN
        RAISE EXCEPTION 'no table in app has a classification column';
    END IF;
END $$;

BEGIN;
-- A writer must state both columns, and only a PRD 9.1 class is accepted.
DO $$
BEGIN
    BEGIN
        INSERT INTO app.asset (org_id, type, simulated) VALUES ('org-test', 'linear', true);
        RAISE EXCEPTION 'an Asset without classification was accepted';
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO app.asset (org_id, type, classification) VALUES ('org-test', 'linear', 'INTERNAL');
        RAISE EXCEPTION 'an Asset without simulated was accepted';
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO app.asset (org_id, type, simulated, classification) VALUES ('org-test', 'linear', true, 'internal');
        RAISE EXCEPTION 'a classification outside the PRD 9.1 classes was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO app.asset (org_id, type, simulated, classification) VALUES ('org-test', 'linear', true, 'HIGHLY_RESTRICTED');
    -- A partition of signal follows its parent.
    BEGIN
        INSERT INTO app.signal (org_id, source, tag, value, observed_at, simulated)
        VALUES ('org-test', 'simulator', 'rain_mm_per_h', 1, '2026-10-18 05:00:00+00', true);
        RAISE EXCEPTION 'a Signal without classification was accepted';
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
END $$;
ROLLBACK;
