-- migrate:up
SET search_path = app, public;

CREATE UNIQUE INDEX uq_app_user_org_keycloak_sub
    ON app_user (org_id, keycloak_sub);

ALTER TABLE user_session
    ADD COLUMN wrapped_data_key bytea,
    ADD COLUMN id_token bytea,
    ADD COLUMN clearance text NOT NULL DEFAULT 'INTERNAL',
    ADD COLUMN last_active_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN access_expires_at timestamptz;

CREATE INDEX idx_user_session_keycloak_sid ON user_session (keycloak_sid);
CREATE INDEX idx_user_session_expiry ON user_session (expires_at);

CREATE TABLE oidc_login_transaction (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text NOT NULL DEFAULT 'INTERNAL',
    state_hash text NOT NULL UNIQUE,
    nonce text NOT NULL,
    pkce_verifier bytea NOT NULL,
    wrapped_data_key bytea NOT NULL,
    return_path text NOT NULL,
    reauth_session_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX idx_oidc_login_transaction_expiry ON oidc_login_transaction (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON oidc_login_transaction TO fieldloop_app;

-- Cloud Run identities connect with Cloud SQL IAM and can read only their own environment DB.
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fieldloop_app_dev') THEN
        CREATE ROLE fieldloop_app_dev NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fieldloop_app_demo') THEN
        CREATE ROLE fieldloop_app_demo NOLOGIN;
    END IF;
END $$;

-- Each migration job runs against one environment's database. These grants are
-- database-local, while the IAM role memberships are cluster-wide, so select
-- only the matching environment in both places.
DO $$ BEGIN
    IF current_database() = 'fieldloop_dev' THEN
        GRANT USAGE ON SCHEMA app TO fieldloop_app_dev;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO fieldloop_app_dev;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO fieldloop_app_dev;
        REVOKE UPDATE, DELETE ON audit_event, approval FROM fieldloop_app_dev;

        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fl-v2-web-api-dev@example-project.iam') THEN
            GRANT fieldloop_app_dev TO "fl-v2-web-api-dev@example-project.iam";
        END IF;
    ELSIF current_database() = 'fieldloop_demo' THEN
        GRANT USAGE ON SCHEMA app TO fieldloop_app_demo;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO fieldloop_app_demo;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO fieldloop_app_demo;
        REVOKE UPDATE, DELETE ON audit_event, approval FROM fieldloop_app_demo;

        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fl-v2-web-api-demo@example-project.iam') THEN
            GRANT fieldloop_app_demo TO "fl-v2-web-api-demo@example-project.iam";
        END IF;
    END IF;
END $$;

-- migrate:down
SET search_path = app, public;
DROP TABLE oidc_login_transaction;
DROP INDEX idx_user_session_expiry;
DROP INDEX idx_user_session_keycloak_sid;
ALTER TABLE user_session
    DROP COLUMN access_expires_at,
    DROP COLUMN last_active_at,
    DROP COLUMN clearance,
    DROP COLUMN id_token,
    DROP COLUMN wrapped_data_key;
DROP INDEX uq_app_user_org_keycloak_sub;
DO $$ BEGIN
    IF current_database() = 'fieldloop_dev' THEN
        REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app FROM fieldloop_app_dev;
        REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app FROM fieldloop_app_dev;
        REVOKE USAGE ON SCHEMA app FROM fieldloop_app_dev;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fl-v2-web-api-dev@example-project.iam') THEN
            REVOKE fieldloop_app_dev FROM "fl-v2-web-api-dev@example-project.iam";
        END IF;
    ELSIF current_database() = 'fieldloop_demo' THEN
        REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app FROM fieldloop_app_demo;
        REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app FROM fieldloop_app_demo;
        REVOKE USAGE ON SCHEMA app FROM fieldloop_app_demo;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fl-v2-web-api-demo@example-project.iam') THEN
            REVOKE fieldloop_app_demo FROM "fl-v2-web-api-demo@example-project.iam";
        END IF;
    END IF;
    BEGIN
        DROP ROLE fieldloop_app_dev;
    EXCEPTION WHEN dependent_objects_still_exist THEN NULL;
    END;
    BEGIN
        DROP ROLE fieldloop_app_demo;
    EXCEPTION WHEN dependent_objects_still_exist THEN NULL;
    END;
END $$;
