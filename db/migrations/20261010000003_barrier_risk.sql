-- migrate:up
SET search_path = app, public;
CREATE TABLE independence_group (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    bowtie_id uuid NOT NULL REFERENCES bowtie(id),
    cause text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE barrier (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    type text NOT NULL,
    side text NOT NULL,
    pfd_band numeric,
    health text,
    evidence_interval interval,
    owner_id uuid REFERENCES app_user(id),
    independence_group_id uuid REFERENCES independence_group(id),
    triad jsonb,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE barrier_path (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    barrier_id uuid NOT NULL REFERENCES barrier(id),
    threat_id uuid REFERENCES threat(id),
    consequence_id uuid REFERENCES consequence(id),
    position int NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    CHECK ((threat_id IS NOT NULL AND consequence_id IS NULL) OR (threat_id IS NULL AND consequence_id IS NOT NULL))
);

CREATE TABLE degradation_factor (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    barrier_id uuid NOT NULL REFERENCES barrier(id),
    description text NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE degradation_control (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    degradation_factor_id uuid NOT NULL REFERENCES degradation_factor(id),
    description text NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE risk_snapshot (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    bowtie_id uuid NOT NULL REFERENCES bowtie(id),
    top_event_freq numeric,
    per_consequence_cells jsonb,
    trigger text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

-- migrate:down
DROP TABLE risk_snapshot;
DROP TABLE degradation_control;
DROP TABLE degradation_factor;
DROP TABLE barrier_path;
DROP TABLE barrier;
DROP TABLE independence_group;
