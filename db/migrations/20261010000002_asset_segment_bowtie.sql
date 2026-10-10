-- migrate:up
SET search_path = app, public;
CREATE TABLE asset (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    type text NOT NULL,
    parent_id uuid REFERENCES asset(id),
    domain_pack text,
    geom geometry(Geometry, 4326),
    attributes jsonb,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);
CREATE INDEX idx_asset_geom ON asset USING GIST (geom);

CREATE TABLE segment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    asset_id uuid NOT NULL REFERENCES asset(id),
    chainage_from numeric,
    chainage_to numeric,
    geom geometry(LineString, 4326),
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);
CREATE INDEX idx_segment_geom ON segment USING GIST (geom);

CREATE TABLE threat_category (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    pack text NOT NULL,
    code text NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE asset_threat_category (
    asset_id uuid NOT NULL REFERENCES app.asset(id),
    threat_category_id uuid NOT NULL REFERENCES app.threat_category(id),
    susceptibility text,
    org_id text NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    PRIMARY KEY (asset_id, threat_category_id)
);

CREATE TABLE bowtie (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    hazard text NOT NULL,
    top_event text NOT NULL,
    domain text,
    status text,
    version text,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE bowtie_asset (
    bowtie_id uuid NOT NULL REFERENCES app.bowtie(id),
    asset_id uuid NOT NULL REFERENCES app.asset(id),
    org_id text NOT NULL,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    PRIMARY KEY (bowtie_id, asset_id)
);

CREATE TABLE threat (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    bowtie_id uuid NOT NULL REFERENCES bowtie(id),
    threat_category_id uuid REFERENCES threat_category(id),
    frequency_per_year numeric,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE consequence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    bowtie_id uuid NOT NULL REFERENCES bowtie(id),
    severity jsonb,
    p_conditional numeric,
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

CREATE TABLE cross_domain_link (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    from_consequence_id uuid NOT NULL REFERENCES consequence(id),
    to_threat_id uuid NOT NULL REFERENCES threat(id),
    simulated boolean NOT NULL DEFAULT false,
    classification text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

-- migrate:down
SET search_path = app, public;
DROP TABLE cross_domain_link;
DROP TABLE consequence;
DROP TABLE threat;
DROP TABLE bowtie_asset;
DROP TABLE bowtie;
DROP TABLE asset_threat_category;
DROP TABLE threat_category;
DROP TABLE segment;
DROP TABLE asset;
