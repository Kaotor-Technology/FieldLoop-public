-- migrate:up
SET search_path = app, public;
-- Runtime services connect as members of fieldloop_app. Grants are explicit: a later migration
-- that adds a table must grant it here-style, so an append-only table is never writable by default.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO fieldloop_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO fieldloop_app;

-- Append-only records: the application can add and read, never change or remove.
REVOKE UPDATE, DELETE ON audit_event, approval FROM fieldloop_app;

-- migrate:down
SET search_path = app, public;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM fieldloop_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM fieldloop_app;
