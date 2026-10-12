-- Assertions on a database that the DL-01 seed has loaded (scripts/test-seed.sh).
-- Pass the seeded Organisation as the psql variable org_id.
SET search_path = app, public;
SELECT set_config('fieldloop.seed_org_id', :'org_id', false);

-- One DL-01 pipeline Asset, with Segments covering Chainage 0-180,000 m without gap or overlap.
DO $$
DECLARE
    pipeline_id uuid;
    segment_count bigint;
    broken_count bigint;
    last_chainage numeric;
BEGIN
    IF (SELECT count(*) FROM asset WHERE attributes->>'asset_code' = 'DL-01') <> 1 THEN
        RAISE EXCEPTION 'expected exactly one DL-01 pipeline Asset';
    END IF;
    SELECT id INTO pipeline_id FROM asset WHERE attributes->>'asset_code' = 'DL-01';

    WITH ordered AS (
        SELECT chainage_from,
               chainage_to,
               lag(chainage_to) OVER (ORDER BY chainage_from) AS previous_to
        FROM segment
        WHERE asset_id = pipeline_id
    )
    SELECT count(*),
           count(*) FILTER (
               WHERE chainage_from IS NULL
                  OR chainage_to IS NULL
                  OR chainage_from >= chainage_to
                  OR chainage_from IS DISTINCT FROM coalesce(previous_to, 0)
           ),
           max(chainage_to)
    INTO segment_count, broken_count, last_chainage
    FROM ordered;

    IF segment_count = 0 THEN
        RAISE EXCEPTION 'the DL-01 Asset has no Segments';
    END IF;
    IF broken_count <> 0 THEN
        RAISE EXCEPTION '% DL-01 Segments leave a gap, overlap or have no Chainage', broken_count;
    END IF;
    IF last_chainage IS DISTINCT FROM 180000 THEN
        RAISE EXCEPTION 'DL-01 Segments end at Chainage % m, expected 180000', last_chainage;
    END IF;
    IF (SELECT count(*) FROM segment WHERE asset_id IS DISTINCT FROM pipeline_id) <> 0 THEN
        RAISE EXCEPTION 'a Segment belongs to an Asset other than DL-01';
    END IF;
END $$;

-- Every table the seed writes holds rows, so the checks below cannot pass on an empty load.
DO $$
DECLARE
    seeded_table text;
    row_count bigint;
BEGIN
    FOREACH seeded_table IN ARRAY ARRAY[
        'organisation', 'asset', 'segment', 'bowtie', 'bowtie_asset', 'threat', 'consequence',
        'independence_group', 'barrier', 'barrier_path', 'degradation_factor',
        'degradation_control', 'evidence'
    ]
    LOOP
        EXECUTE format('SELECT count(*) FROM app.%I', seeded_table) INTO row_count;
        IF row_count = 0 THEN
            RAISE EXCEPTION 'the seed loaded no rows into app.%', seeded_table;
        END IF;
    END LOOP;
END $$;

-- One Organisation row, and an Evidence history of at least two records on every Barrier.
DO $$
DECLARE
    thin_count bigint;
BEGIN
    IF (SELECT count(*) FROM organisation WHERE org_id = current_setting('fieldloop.seed_org_id')) <> 1 THEN
        RAISE EXCEPTION 'expected exactly one organisation row for the seeded Organisation';
    END IF;
    SELECT count(*) INTO thin_count
    FROM barrier b
    WHERE (SELECT count(*) FROM evidence e WHERE e.barrier_id = b.id) < 2;
    IF thin_count <> 0 THEN
        RAISE EXCEPTION '% Barriers have fewer than two Evidence records', thin_count;
    END IF;
END $$;

-- PRD 9.1: Asset geometry is Highly Restricted, Bowtie and Barrier records are Confidential,
-- and the Organisation row is Internal.
DO $$
DECLARE
    seeded record;
    wrong_count bigint;
BEGIN
    FOR seeded IN
        SELECT * FROM (VALUES
            ('organisation', 'INTERNAL'),
            ('asset', 'HIGHLY_RESTRICTED'), ('segment', 'HIGHLY_RESTRICTED'),
            ('bowtie', 'CONFIDENTIAL'), ('bowtie_asset', 'CONFIDENTIAL'), ('threat', 'CONFIDENTIAL'),
            ('consequence', 'CONFIDENTIAL'), ('independence_group', 'CONFIDENTIAL'), ('barrier', 'CONFIDENTIAL'),
            ('barrier_path', 'CONFIDENTIAL'), ('degradation_factor', 'CONFIDENTIAL'),
            ('degradation_control', 'CONFIDENTIAL'), ('evidence', 'CONFIDENTIAL')
        ) AS expected(table_name, classification)
    LOOP
        EXECUTE format('SELECT count(*) FROM app.%I WHERE classification <> %L', seeded.table_name, seeded.classification)
        INTO wrong_count;
        IF wrong_count <> 0 THEN
            RAISE EXCEPTION '% rows in app.% are not classified %', wrong_count, seeded.table_name, seeded.classification;
        END IF;
    END LOOP;
END $$;

-- Every row in the app schema carries the seeded org_id, simulated = true and a classification.
DO $$
DECLARE
    app_table record;
    bad_count bigint;
BEGIN
    FOR app_table IN
        SELECT t.table_name,
               (SELECT count(*)
                FROM information_schema.columns c
                WHERE c.table_schema = t.table_schema
                  AND c.table_name = t.table_name
                  AND c.column_name IN ('org_id', 'simulated', 'classification')) = 3 AS labelled
        FROM information_schema.tables t
        WHERE t.table_schema = 'app' AND t.table_type = 'BASE TABLE'
    LOOP
        IF app_table.labelled THEN
            EXECUTE format(
                'SELECT count(*) FROM app.%I
                 WHERE org_id IS DISTINCT FROM current_setting(''fieldloop.seed_org_id'')
                    OR simulated IS NOT TRUE
                    OR classification IS NULL
                    OR btrim(classification) = ''''',
                app_table.table_name
            ) INTO bad_count;
        ELSE
            -- A table without the three columns must stay untouched by the seed.
            EXECUTE format('SELECT count(*) FROM app.%I', app_table.table_name) INTO bad_count;
        END IF;
        IF bad_count <> 0 THEN
            RAISE EXCEPTION '% rows in app.% lack the seeded org_id, simulated = true or a classification',
                bad_count, app_table.table_name;
        END IF;
    END LOOP;
END $$;
