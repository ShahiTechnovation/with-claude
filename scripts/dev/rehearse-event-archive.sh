#!/usr/bin/env bash
# LOCAL REHEARSAL of the September 2026 event-archive import, end to end, on a
# FRESH local database and the file-backed Baserow fixture:
#
#   migrations → curated import → Luma feed snapshot → adopt the two events in
#   "Baserow" → link check → plan → apply (publish) → sync/projection → the
#   reconciliation report → a second plan+apply that must change nothing.
#
#   scripts/dev/rehearse-event-archive.sh "<Impact Lab 2.xlsx>" "<Fable 5.1.xlsx>" [db_name]
#
# Needs a local PostgreSQL on 127.0.0.1:${PGPORT:-55432}. Refuses anything else.
set -euo pipefail

IMPACT="${1:?Impact Lab 2 workbook path}"
FABLE="${2:?Fable 5.1 workbook path}"
DB="${3:-withclaude_directory}"
PORT="${PGPORT:-55432}"

export DATABASE_URL="postgresql://postgres@127.0.0.1:${PORT}/${DB}"
export BASEROW_FIXTURE="imports/rehearsal-baserow.json"

psql -h 127.0.0.1 -p "$PORT" -U postgres -qc "DROP DATABASE IF EXISTS ${DB}" -c "CREATE DATABASE ${DB}"
rm -f "$BASEROW_FIXTURE"

npx tsx db/migrate.ts
npm run --silent db:import > /dev/null
npx tsx scripts/dev/ingest-sample-feed.ts > /dev/null
npm run --silent import -- fixture-seed --yes
npm run --silent import -- sync --yes

if [ ! -f imports/link-checks.json ] || [ "${RECHECK_LINKS:-0}" = "1" ]; then
  npm run --silent import -- verify-links --all --impact "$IMPACT" --fable "$FABLE"
fi

npm run --silent import -- archive-plan --impact "$IMPACT" --fable "$FABLE"
PLAN="$(ls -td imports/*/ | head -1)plan.json"
npm run --silent import -- apply --plan "$PLAN" --publish --yes
npm run --silent import -- sync --yes
npm run --silent import -- archive-report --impact "$IMPACT" --fable "$FABLE"

echo "── idempotency: the same import again must create and update nothing"
npm run --silent import -- archive-plan --impact "$IMPACT" --fable "$FABLE" | grep -E "^\| [0-9]+ \||^Decisions"
PLAN="$(ls -td imports/*/ | head -1)plan.json"
npm run --silent import -- apply --plan "$PLAN" --publish --yes | grep -E '"(created|updated|credits)"'
psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -tAc \
  "select 'baserow projects: ' || count(*) from projects where content_authority = 'baserow'"
