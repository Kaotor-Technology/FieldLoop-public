-- Regression check for the normalized display fields required by Bowtie A.
DO $$
DECLARE
    missing_columns text[];
BEGIN
    SELECT array_agg(required.table_name || '.' || required.column_name ORDER BY required.table_name, required.column_name)
    INTO missing_columns
    FROM (VALUES
        ('threat', 'name'),
        ('consequence', 'name'),
        ('barrier', 'name'),
        ('barrier', 'performance_standard')
    ) AS required(table_name, column_name)
    WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.columns AS actual
        WHERE actual.table_schema = 'app'
          AND actual.table_name = required.table_name
          AND actual.column_name = required.column_name
    );

    IF missing_columns IS NOT NULL THEN
        RAISE EXCEPTION 'Bowtie A seed columns are missing: %', array_to_string(missing_columns, ', ');
    END IF;
END;
$$;
