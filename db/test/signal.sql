-- Regression tests for Signal columns and daily partitions (architecture 5.1 and 5.3, FL-60).
BEGIN;

INSERT INTO app.signal (org_id, source, tag, value, observed_at, simulated)
VALUES ('org-test', 'simulator', 'rain_mm_per_h', 12.5, '2026-10-18 05:00:00+00', true);

DO $$
BEGIN
    IF (SELECT count(*) FROM app.signal_y2026m10d18) <> 1 OR (SELECT count(*) FROM app.signal_default) <> 0 THEN
        RAISE EXCEPTION 'a demo-day Signal must land in its daily partition';
    END IF;
END $$;

ROLLBACK;
