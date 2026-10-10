-- migrate:up
SET search_path = app, public;
CREATE TABLE app_user (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    keycloak_sub text NOT NULL,
    display_name text,
    roles_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE user_session (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    session_id text NOT NULL UNIQUE,
    app_user_id uuid NOT NULL REFERENCES app_user(id),
    keycloak_sid text,
    access_token bytea,
    refresh_token bytea,
    auth_time timestamptz,
    roles jsonb,
    csrf_token text NOT NULL,
    last_validated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE organisation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    name text NOT NULL,
    central_location geometry(Point, 4326),
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE INDEX idx_organisation_geom ON organisation USING GIST (central_location);

-- migrate:down
SET search_path = app, public;
DROP TABLE organisation;
DROP TABLE user_session;
DROP TABLE app_user;
