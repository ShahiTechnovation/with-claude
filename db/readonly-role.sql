-- A read-only role for the public build (§25, §10 of the Phase 3
-- infrastructure verification).
--
-- ── WHY THIS IS SCOPED TABLE-BY-TABLE RATHER THAN "ALL TABLES" ───────────
--
-- The version documented in `.env.example` before this file existed granted
-- SELECT on every table and relied on the application layer — `source-db.ts`
-- only ever queries the 24 tables below — to keep the build away from
-- anything private. That is true today, but it makes the DATABASE do no work
-- to enforce it: a future change to the reader that accidentally touched
-- `submissions.submitter_email` would be caught by nothing except code
-- review.
--
-- This script instead grants SELECT on exactly the tables
-- `src/data/source-db.ts` reads — enumerated by grepping the reader itself,
-- not retyped from memory — and grants NOTHING on the rest. In particular,
-- nothing on:
--
--   submissions       has submitter_email, ip_hash, user_agent, the raw
--                     payload — none of it public, none of it needed by a
--                     build
--   city_interest     has email; verification status is an editorial fact,
--                     not a build input
--   users, sessions,
--   verifications,
--   accounts          the entire admin authentication surface
--   audit_log         editorial history, not public content
--
-- If the reader is ever extended to a table not in this list, the build's own
-- connection refuses the query with a permission error — a loud failure
-- that names the table, rather than a silent new leak.
--
-- ── HOW TO USE THIS ────────────────────────────────────────────────────
--
-- Run once, against Neon, connected as a role that can CREATE ROLE and GRANT
-- (the Neon dashboard's SQL editor, connected as the project owner, can do
-- this). Then take the connection string Neon gives you for this role and
-- set it as DATABASE_URL_READONLY.
--
-- This file is NOT applied automatically by any script in this repository.
-- Running DDL against production is a decision, not a build step.

-- Replace the password before running. Neon requires TLS by default, so a
-- plain password here is fine — it never travels except over that connection.
CREATE ROLE withclaude_build WITH LOGIN PASSWORD 'CHANGE_ME';

GRANT CONNECT ON DATABASE neondb TO withclaude_build;
GRANT USAGE ON SCHEMA public TO withclaude_build;

-- Exactly the 24 tables `loadRecordSet()` queries, and nothing else.
GRANT SELECT ON TABLE
  cities,
  builders,
  ambassadors,
  events,
  event_co_hosts,
  event_speakers,
  event_attendees,
  event_organizations,
  event_agenda_items,
  event_outcomes,
  event_photos,
  projects,
  project_builders,
  stories,
  story_builders,
  use_cases,
  use_case_workflow_steps,
  use_case_artifacts,
  guides,
  guide_sections,
  sources,
  social_links,
  organizations,
  media
TO withclaude_build;

-- Explicit revokes, in case a wider default was ever applied. Belt and
-- braces: the absence of a GRANT above already means no access, but this
-- makes the refusal show up in \dp rather than only in what is missing from
-- it.
REVOKE ALL ON TABLE submissions FROM withclaude_build;
REVOKE ALL ON TABLE city_interest FROM withclaude_build;
REVOKE ALL ON TABLE users FROM withclaude_build;
REVOKE ALL ON TABLE sessions FROM withclaude_build;
REVOKE ALL ON TABLE verifications FROM withclaude_build;
REVOKE ALL ON TABLE accounts FROM withclaude_build;
REVOKE ALL ON TABLE audit_log FROM withclaude_build;

-- No INSERT, UPDATE, DELETE, or DDL anywhere — the absence of any such GRANT
-- above is the whole control. Verify with, connected as withclaude_build:
--
--   INSERT INTO builders (slug, name, city_id, role) VALUES ('x','x','00000000-0000-0000-0000-000000000000','x');
--   -- should fail: permission denied for table builders
