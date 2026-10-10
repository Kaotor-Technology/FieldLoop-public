# Disposable PostgreSQL 16 with PostGIS and pgvector for migration tests (scripts/test-migrations.sh).
FROM pgvector/pgvector:0.8.1-pg16
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-postgis-3 \
    && rm -rf /var/lib/apt/lists/*
