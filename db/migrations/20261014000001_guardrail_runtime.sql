-- migrate:up
SET search_path = app, public;
CREATE TABLE app.guardrail_content_request (
    org_id text NOT NULL,
    idempotency_key_hash char(64) NOT NULL,
    request_hash char(64) NOT NULL,
    status_code smallint NOT NULL CHECK (status_code IN (200, 403, 503)),
    decision text NOT NULL CHECK (decision IN ('allow', 'redact', 'block', 'reroute')),
    policy_id uuid NOT NULL REFERENCES app.guardrail_policy(id),
    intercept_id uuid NOT NULL REFERENCES app.intercept(id),
    detected_classification text NOT NULL CHECK (detected_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    reason text NOT NULL,
    simulated boolean NOT NULL,
    classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL,
    PRIMARY KEY (org_id, idempotency_key_hash)
);

DO $$
DECLARE
    environment text;
    guardrail_role text;
    runtime_role text;
BEGIN
    -- Roles and grants exist only in FieldLoop dev/demo and the repo's fieldloop_*test databases.
    -- Other databases (for example integration fixtures) get the table without any grant.
    IF NOT (current_database() IN ('fieldloop_dev', 'fieldloop_demo', 'fieldloop_restricted') OR current_database() LIKE 'fieldloop\_%test') THEN
        RETURN;
    END IF;

    environment := replace(current_database(), 'fieldloop_', '');
    guardrail_role := 'fieldloop_guardrail_' || environment;
    runtime_role := 'fl-v2-guardrail-' || environment || '@example-project.iam';

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = guardrail_role) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN', guardrail_role);
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', guardrail_role);
    EXECUTE format('GRANT SELECT ON app.ai_system, app.guardrail_policy TO %I', guardrail_role);
    EXECUTE format('GRANT INSERT ON app.intercept, app.evidence, app.signal_event_outbox TO %I', guardrail_role);

    EXECUTE format('GRANT SELECT, INSERT ON app.guardrail_content_request TO %I', guardrail_role);

    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo')
        AND EXISTS (SELECT FROM pg_roles WHERE rolname = runtime_role) THEN
        EXECUTE format('GRANT %I TO %I', guardrail_role, runtime_role);
    END IF;
END $$;

-- migrate:down
SET search_path = app, public;
DO $$
DECLARE
    environment text;
    guardrail_role text;
    runtime_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo', 'fieldloop_restricted') OR current_database() LIKE 'fieldloop\_%test' THEN
        environment := replace(current_database(), 'fieldloop_', '');
        guardrail_role := 'fieldloop_guardrail_' || environment;
        runtime_role := 'fl-v2-guardrail-' || environment || '@example-project.iam';
        IF current_database() IN ('fieldloop_dev', 'fieldloop_demo')
            AND EXISTS (SELECT FROM pg_roles WHERE rolname = runtime_role) THEN
            EXECUTE format('REVOKE %I FROM %I', guardrail_role, runtime_role);
        END IF;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = guardrail_role) THEN
            EXECUTE format('REVOKE ALL ON app.ai_system, app.guardrail_policy, app.intercept, app.evidence, app.signal_event_outbox, app.guardrail_content_request FROM %I', guardrail_role);
            EXECUTE format('REVOKE USAGE ON SCHEMA app FROM %I', guardrail_role);
        END IF;
    END IF;
END $$;
DROP TABLE app.guardrail_content_request;
DO $$
DECLARE
    guardrail_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo', 'fieldloop_restricted') OR current_database() LIKE 'fieldloop\_%test' THEN
        guardrail_role := 'fieldloop_guardrail_' || replace(current_database(), 'fieldloop_', '');
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = guardrail_role) THEN
            EXECUTE format('DROP ROLE %I', guardrail_role);
        END IF;
    END IF;
END $$;
