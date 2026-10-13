-- migrate:up
SET search_path = app, public;
-- Generic content codes resolve pack selectors without domain-specific columns or UUID recipes.
ALTER TABLE bowtie ADD COLUMN code text;
ALTER TABLE barrier ADD COLUMN code text;
CREATE UNIQUE INDEX uq_bowtie_org_code ON bowtie (org_id, code) WHERE code IS NOT NULL;
CREATE INDEX idx_barrier_org_code ON barrier (org_id, code);
CREATE INDEX idx_signal_rule_source ON signal_rule (org_id, (condition->>'source'), (condition->>'tag'));
CREATE INDEX idx_audit_event_org_created ON audit_event (org_id, created_at DESC, id DESC);

CREATE TABLE signal_receipt (
    id uuid NOT NULL,
    org_id text NOT NULL,
    signal_id bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    stream_key text NOT NULL,
    content jsonb NOT NULL,
    simulated boolean NOT NULL,
    classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (signal_id, observed_at) REFERENCES signal(id, observed_at)
);
CREATE INDEX idx_signal_receipt_history ON signal_receipt (org_id, stream_key, observed_at DESC);
ALTER TABLE evidence ADD COLUMN signal_receipt_id uuid;
ALTER TABLE evidence ADD CONSTRAINT fk_evidence_signal_receipt FOREIGN KEY (org_id, signal_receipt_id) REFERENCES signal_receipt(org_id, id);
CREATE UNIQUE INDEX uq_evidence_signal_barrier ON evidence (org_id, signal_receipt_id, barrier_id) WHERE signal_receipt_id IS NOT NULL;
ALTER TABLE health_proposal ADD COLUMN signal_receipt_id uuid;
ALTER TABLE health_proposal ADD CONSTRAINT fk_proposal_signal_receipt FOREIGN KEY (org_id, signal_receipt_id) REFERENCES signal_receipt(org_id, id);
CREATE UNIQUE INDEX uq_proposal_signal_rule_barrier ON health_proposal (org_id, signal_receipt_id, source_rule_id, barrier_id) WHERE signal_receipt_id IS NOT NULL;

CREATE TABLE signal_dependency (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    rule_id uuid NOT NULL REFERENCES signal_rule(id),
    barrier_id uuid NOT NULL REFERENCES barrier(id),
    expected_interval_seconds integer CHECK (expected_interval_seconds > 0),
    expected_interval_months integer CHECK (expected_interval_months BETWEEN 1 AND 12),
    last_received_at timestamptz,
    last_observed_at timestamptz,
    simulated boolean NOT NULL,
    classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL,
    UNIQUE (org_id, rule_id, barrier_id),
    CHECK ((expected_interval_seconds IS NULL) <> (expected_interval_months IS NULL))
);
CREATE INDEX idx_signal_dependency_due ON signal_dependency (org_id, COALESCE(last_received_at, created_at));

CREATE TABLE signal_event_outbox (
    id uuid PRIMARY KEY,
    org_id text NOT NULL,
    event jsonb NOT NULL,
    published_at timestamptz,
    simulated boolean NOT NULL,
    classification text NOT NULL CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL
);
CREATE INDEX idx_signal_outbox_pending ON signal_event_outbox (org_id, created_at) WHERE published_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON signal_receipt, signal_dependency, signal_event_outbox TO fieldloop_app;
DO $$
DECLARE environment text; app_role text; worker_role text;
BEGIN
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') THEN
        environment := replace(current_database(), 'fieldloop_', '');
        app_role := 'fieldloop_app_' || environment;
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON app.signal_receipt, app.signal_dependency, app.signal_event_outbox TO %I', app_role);
        worker_role := 'fl-v2-signal-worker-' || environment || '@example-project.iam';
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = worker_role) THEN
            EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', worker_role);
            EXECUTE format('GRANT SELECT ON app.signal_rule, app.barrier, app.barrier_path, app.threat, app.consequence, app.bowtie, app.bowtie_asset, app.asset, app.evidence, app.geo_reference TO %I', worker_role);
            EXECUTE format('GRANT SELECT, INSERT ON app.signal, app.signal_receipt, app.evidence, app.health_proposal, app.health_change, app.audit_event TO %I', worker_role);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON app.signal_dependency, app.signal_event_outbox TO %I', worker_role);
            EXECUTE format('GRANT UPDATE (health) ON app.barrier TO %I', worker_role);
            EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE app.signal_id_seq TO %I', worker_role);
        END IF;
    END IF;
END $$;

-- migrate:down
SET search_path = app, public;
DO $$
DECLARE worker_role text;
BEGIN
    worker_role := 'fl-v2-signal-worker-' || replace(current_database(), 'fieldloop_', '') || '@example-project.iam';
    IF current_database() IN ('fieldloop_dev', 'fieldloop_demo') AND EXISTS (SELECT FROM pg_roles WHERE rolname = worker_role) THEN
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', worker_role);
        EXECUTE format('REVOKE UPDATE (health) ON app.barrier FROM %I', worker_role);
        EXECUTE format('REVOKE ALL ON SEQUENCE app.signal_id_seq FROM %I', worker_role);
        EXECUTE format('REVOKE USAGE ON SCHEMA app FROM %I', worker_role);
    END IF;
END $$;
DROP TABLE signal_event_outbox;
DROP TABLE signal_dependency;
ALTER TABLE health_proposal DROP COLUMN signal_receipt_id;
ALTER TABLE evidence DROP COLUMN signal_receipt_id;
DROP TABLE signal_receipt;
DROP INDEX idx_signal_rule_source;
DROP INDEX idx_audit_event_org_created;
ALTER TABLE barrier DROP COLUMN code;
ALTER TABLE bowtie DROP COLUMN code;
