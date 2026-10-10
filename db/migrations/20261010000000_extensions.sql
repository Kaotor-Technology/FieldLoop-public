-- migrate:up
SET search_path = app, public;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

-- Create app role and grant basic permissions
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fieldloop_app') THEN
        CREATE ROLE fieldloop_app NOLOGIN;
    END IF;
END $$;
GRANT USAGE ON SCHEMA app TO fieldloop_app;

-- migrate:down
SET search_path = app, public;
DROP OWNED BY fieldloop_app;
DROP ROLE IF EXISTS fieldloop_app;
DROP SCHEMA IF EXISTS app CASCADE;
DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS vector;
DROP EXTENSION IF EXISTS postgis;
