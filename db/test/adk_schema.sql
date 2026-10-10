-- Regression tests for the adk schema privileges (architecture 7.1, FL-60).
BEGIN;

-- The assistant's role can create ADK's tables.
SET LOCAL ROLE fieldloop_assistant;
CREATE TABLE adk.sessions (id text PRIMARY KEY);
RESET ROLE;

-- The general app role cannot.
SET LOCAL ROLE fieldloop_app;
DO $$
BEGIN
    BEGIN
        CREATE TABLE adk.events (id text PRIMARY KEY);
    EXCEPTION WHEN insufficient_privilege THEN
        RETURN;
    END;
    RAISE EXCEPTION 'fieldloop_app must not create tables in schema adk';
END $$;
RESET ROLE;

ROLLBACK;
