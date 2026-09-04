-- Make the audit log actually append-only.
--
-- A table named `audit_log` that anyone can UPDATE is not an audit log, it is
-- a table. The trigger below is the difference: once a row is written, it
-- cannot be edited or removed by the application, by a migration, or by
-- somebody at a psql prompt who has the app's credentials.
--
-- Correcting a mistaken entry is done by appending a correcting entry, which
-- is the point — the history of what was believed is itself part of the
-- record.

CREATE OR REPLACE FUNCTION audit_log_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: % is not permitted. Append a correcting entry instead.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();
--> statement-breakpoint

-- A TRUNCATE would empty the table without firing a row-level trigger, so it
-- gets its own statement-level guard.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_mutation();
