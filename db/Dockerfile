# dbmate 2.28.0, the same pinned base as the bootstrap runner in infra/migration.
FROM ghcr.io/amacneil/dbmate@sha256:f14378f8ac7de65bc6d35e81769a288b18d18386a139088384d39f0db40de9d9
COPY db/migrations /db/migrations
# The migrations set search_path, so pin the tracking table to a fixed schema.
ENV DBMATE_MIGRATIONS_TABLE=public.schema_migrations \
    DBMATE_NO_DUMP_SCHEMA=true
USER 10001:10001
ENTRYPOINT ["dbmate"]
CMD ["up"]
