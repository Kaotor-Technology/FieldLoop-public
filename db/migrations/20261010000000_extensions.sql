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

-- migrate:down
SET search_path = app, public;
-- Roles are cluster-wide and other databases on the instance may still use fieldloop_app,
-- so only this database's grants are removed and the role is kept.
DROP OWNED BY fieldloop_app;
DROP SCHEMA IF EXISTS app CASCADE;
-- PostGIS and pgvector are infrastructure-owned and stay installed.
