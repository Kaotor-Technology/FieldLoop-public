FROM ghcr.io/amacneil/dbmate:2.15.0
COPY db/migrations /db/migrations
# The migrations set search_path, so pin the tracking table to a fixed schema.
ENV DBMATE_MIGRATIONS_TABLE=public.schema_migrations \
    DBMATE_NO_DUMP_SCHEMA=true
ENTRYPOINT ["dbmate"]
CMD ["up"]
