-- migrate:up
CREATE TABLE evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    barrier_id uuid NOT NULL REFERENCES barrier(id),
    kind text NOT NULL,
    source text NOT NULL,
    observed_at timestamptz NOT NULL,
    blob_uri text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);
CREATE INDEX idx_evidence_barrier_observed ON evidence (barrier_id, observed_at DESC);

CREATE TABLE geo_reference (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    evidence_id uuid NOT NULL REFERENCES evidence(id),
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    kind text NOT NULL,
    geom geometry(Geometry, 4326),
    chainage_from numeric,
    chainage_to numeric,
    status text,
    confidence numeric,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);
CREATE INDEX idx_geo_reference_geom ON geo_reference USING GIST (geom);

CREATE TABLE signal (
    id bigserial PRIMARY KEY,
    org_id text NOT NULL,
    source text NOT NULL,
    observed_at timestamptz NOT NULL,
    payload jsonb,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
) PARTITION BY RANGE (observed_at);
-- In production, create daily partitions. For demo, we just need a default partition or initial partition
CREATE TABLE signal_default PARTITION OF signal DEFAULT;

CREATE TABLE signal_rule (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    pack text NOT NULL,
    condition jsonb NOT NULL,
    target_barrier_selector jsonb NOT NULL,
    spatial_geom geometry(Geometry, 4326),
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);
CREATE INDEX idx_signal_rule_geom ON signal_rule USING GIST (spatial_geom);

CREATE TABLE health_proposal (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    barrier_id uuid NOT NULL REFERENCES barrier(id),
    proposed_health text NOT NULL,
    source_rule_id uuid REFERENCES signal_rule(id),
    signal_id bigint,
    status text NOT NULL,
    decided_by text,
    reason text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE health_change (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    barrier_id uuid NOT NULL REFERENCES barrier(id),
    from_health text,
    to_health text NOT NULL,
    reason text,
    actor text NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

-- migrate:down
DROP TABLE health_change;
DROP TABLE health_proposal;
DROP TABLE signal_rule;
DROP TABLE signal;
DROP TABLE geo_reference;
DROP TABLE evidence;
