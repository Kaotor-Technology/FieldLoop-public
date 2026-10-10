-- migrate:up
SET search_path = app, public;
CREATE TABLE ai_system (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    name text NOT NULL,
    owner_id uuid REFERENCES app_user(id),
    model_tier text,
    data_classes jsonb,
    tools jsonb,
    risk_class text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE guardrail_policy (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    ai_system_id uuid NOT NULL REFERENCES ai_system(id),
    barrier_id uuid REFERENCES barrier(id),
    tier text,
    config jsonb,
    mode text,
    fail_mode text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE intercept (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    policy_id uuid NOT NULL REFERENCES guardrail_policy(id),
    ai_system_id uuid NOT NULL REFERENCES ai_system(id),
    decision text NOT NULL,
    reason text,
    latency_ms int,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE held_request (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    intercept_id uuid NOT NULL REFERENCES intercept(id),
    payload jsonb,
    status text NOT NULL,
    expires_at timestamptz,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE stakeholder (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    contacts bytea,
    geom geometry(Geometry, 4326),
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);
CREATE INDEX idx_stakeholder_geom ON stakeholder USING GIST (geom);

CREATE TABLE controlled_document (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    folder text,
    title text NOT NULL,
    revision text,
    status text,
    classification text,
    licence text,
    blob_uri text,
    superseded_by uuid REFERENCES controlled_document(id),
    simulated boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE document_chunk (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    document_id uuid NOT NULL REFERENCES controlled_document(id),
    embedding vector(768),
    content text,
    clause text,
    page int,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);
CREATE INDEX idx_document_chunk_embedding ON document_chunk USING hnsw (embedding vector_l2_ops);

CREATE TABLE draft (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    kind text NOT NULL,
    content text,
    citations jsonb,
    confidence numeric,
    status text NOT NULL,
    approved_by text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE assistant_session (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    agent_id text NOT NULL,
    app_user_id uuid REFERENCES app.app_user(id),
    context jsonb,
    status text NOT NULL,
    token_budget_used int,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE agent_step (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    session_id uuid NOT NULL REFERENCES assistant_session(id),
    seq int NOT NULL,
    agent_id text NOT NULL,
    kind text NOT NULL,
    tool_name text,
    args_hash text,
    result_summary text,
    guardrail_decision text,
    model text,
    tokens_in int,
    tokens_out int,
    latency_ms int,
    action_request_id uuid REFERENCES app.action_request(id),
    intercept_id uuid REFERENCES intercept(id),
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE kml_import (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    file_hash text NOT NULL,
    mapping jsonb,
    status text NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE kml_import_item (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    kml_import_id uuid NOT NULL REFERENCES kml_import(id),
    geom geometry(Geometry, 4326),
    snapped_chainage numeric,
    distance numeric,
    target text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);
CREATE INDEX idx_kml_import_item_geom ON kml_import_item USING GIST (geom);

CREATE TABLE scenario (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    file text NOT NULL,
    version text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE simulation_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    scenario_id uuid NOT NULL REFERENCES scenario(id),
    seed int,
    speed numeric,
    clock timestamptz,
    state text NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

-- migrate:down
DROP TABLE simulation_run;
DROP TABLE scenario;
DROP TABLE kml_import_item;
DROP TABLE kml_import;
DROP TABLE agent_step;
DROP TABLE assistant_session;
DROP TABLE draft;
DROP TABLE document_chunk;
DROP TABLE controlled_document;
DROP TABLE stakeholder;
DROP TABLE held_request;
DROP TABLE intercept;
DROP TABLE guardrail_policy;
DROP TABLE ai_system;
