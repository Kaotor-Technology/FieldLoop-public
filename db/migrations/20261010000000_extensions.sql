-- migrate:up
SET search_path = app, public;
-- On Cloud SQL these already exist (infra/terraform/extensions.sql) and the statements are
-- no-ops; they create the extensions for local and test databases.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS app;

-- Create app role and grant basic permissions
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fieldloop_app') THEN
        CREATE ROLE fieldloop_app NOLOGIN;
    END IF;
END $$;
GRANT USAGE ON SCHEMA app TO fieldloop_app;

-- ADK creates and owns its session tables in this schema, outside dbmate (architecture 7.1).
-- Only the assistant's role may create objects there.
CREATE SCHEMA IF NOT EXISTS adk;
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fieldloop_assistant') THEN
        CREATE ROLE fieldloop_assistant NOLOGIN;
    END IF;
END $$;
GRANT USAGE, CREATE ON SCHEMA adk TO fieldloop_assistant;

-- migrate:down
SET search_path = app, public;
-- Roles are cluster-wide and other databases on the instance may still use them, so only this
-- database's grants and objects are removed and the roles are kept.
DROP OWNED BY fieldloop_app;
DROP OWNED BY fieldloop_assistant;
DROP SCHEMA IF EXISTS adk CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;
-- PostGIS and pgvector are infrastructure-owned and stay installed.
