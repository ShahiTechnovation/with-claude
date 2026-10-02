#!/usr/bin/env bash
# THE SEPTEMBER EVENT-ARCHIVE MIGRATION INTO BASEROW — end to end, verified.
#
#   MODE=mirror scripts/dev/run-baserow-migration.sh "<Impact Lab 2.xlsx>" "<Fable 5.1.xlsx>"
#   MODE=real   scripts/dev/run-baserow-migration.sh "<Impact Lab 2.xlsx>" "<Fable 5.1.xlsx>"
#
# mirror  a dress rehearsal against a local file that mirrors the real
#         workspace (table ids, fields, existing rows). Nothing leaves this
#         machine.
# real    the real Baserow tables (BASEROW_IMPORT_TOKEN and BASEROW_CONFIG
#         from .dev-auth/, git-ignored). Writes ONLY rows: events, then
#         projects, then credits (none — no consent is on record).
#
# Both modes then validate the existing sync against a FRESH LOCAL CLONE of
# the local database (never Neon): re-point the earlier rehearsal's mappings
# by source key, stage an approved claim and a moderation hold, sync, verify,
# and prove a second run changes nothing.
#
# Production event ids (Neon ID on the two Events rows) come from the
# read-only production check recorded in docs/runbook-rollout.md.
set -euo pipefail

IMPACT="${1:?Impact Lab 2 workbook path}"
FABLE="${2:?Fable 5.1 workbook path}"
MODE="${MODE:?MODE=mirror or MODE=real}"
PORT="${PGPORT:-55432}"
PSQL="${PSQL:-/c/Program Files/PostgreSQL/18/bin/psql.exe}"
SOURCE_DB="${SOURCE_DB:-withclaude_restore}"
NEON_IDS="impact-lab-2=01d01dde-6451-4ecc-8ffe-f04f14c60118,fable-5-1=63aa1fc0-02fd-4e62-be82-8d3648efe159"
OLD_FIXTURE="imports/rehearsal-baserow.json"

case "$MODE" in
  mirror)
    DB="${DB:-withclaude_mirror}"
    export BASEROW_CONFIG="$(cat "${CONFIG_FILE:-imports/baserow-live/rehearsal.config.json}")"
    export BASEROW_FIXTURE="imports/rehearsal-real-mirror.json"
    SNAP="$(ls imports/baserow-live/snapshot-before-*.json | head -1)"
    npx tsx scripts/dev/make-mirror-fixture.ts "${FIELDS:-imports/baserow-live/expected-fields.json}" "$SNAP" "$BASEROW_FIXTURE"
    ;;
  real)
    DB="${DB:-withclaude_baserow}"
    # shellcheck disable=SC1091
    . .dev-auth/baserow.env.sh
    export BASEROW_CONFIG="$(cat .dev-auth/baserow.config.json)"
    unset BASEROW_FIXTURE
    npm run --silent baserow:check-schema
    ;;
  *) echo "MODE must be mirror or real" >&2; exit 2 ;;
esac

# The local database for the ledger and the sync validation: a fresh clone.
export PGPASSWORD="$(sed -nE 's#.*://[^:]+:([^@]*)@.*#\1#p' .dev-auth/restore.env.sh)"
"$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -qc "DROP DATABASE IF EXISTS ${DB}" -c "CREATE DATABASE ${DB} TEMPLATE ${SOURCE_DB}"
sed "s/${SOURCE_DB}/${DB}/" .dev-auth/restore.env.sh > ".dev-auth/${DB}.env.sh"
# shellcheck disable=SC1090
. ".dev-auth/${DB}.env.sh"
echo "── mode ${MODE}; ledger + validation database ${DB} (local clone of ${SOURCE_DB})"

latest_batch() { ls -td imports/*/ | head -1 | sed 's#/$##'; }

echo "── 1. events: match or create the two canonical rows"
npm run --silent import -- archive-seed-events --yes --neon-ids "$NEON_IDS"

echo "── 2. projects: dry run (snapshot, plan, decisions)"
npm run --silent import -- archive-plan --impact "$IMPACT" --fable "$FABLE" | grep -E "^\| [0-9]+ \||^- (Already|Fields kept|Suspected)|^Decisions|^Snapshot|^Wrote"
BATCH_DIR="$(latest_batch)"
BATCH="$(basename "$BATCH_DIR")"

echo "── 3. projects: apply (draft by default; --publish only where the contract holds and nothing is held)"
npm run --silent import -- apply --plan "$BATCH_DIR/plan.json" --publish --yes | grep -vE '^\s*$'

echo "── 4. read-back verification of what Baserow stores"
npm run --silent import -- archive-verify --batch "$BATCH" --impact "$IMPACT" --fable "$FABLE" --neon-ids "$NEON_IDS" | grep -E "^(pass|FAIL|warn)|VERIF"

echo "── 5. local sync validation: re-point the earlier rehearsal's mappings by source key"
npm run --silent import -- archive-rebind --from-fixture "$OLD_FIXTURE" --yes
npx tsx scripts/dev/stage-claim-and-hold.ts sortx petbot
Q="select id, slug, coalesce(owner_member_id::text,''), content_authority, moderation_state, publication_status from projects order by id"
"$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -At -c "$Q" > "$BATCH_DIR/neon-before-sync.txt"
if [ "$MODE" = real ]; then export BASEROW_READ_TOKEN="${BASEROW_READ_TOKEN:-$BASEROW_IMPORT_TOKEN}"; fi
npm run --silent import -- sync --yes
"$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -At -c "$Q" > "$BATCH_DIR/neon-after-sync.txt"
echo "projects before/after sync: $(wc -l < "$BATCH_DIR/neon-before-sync.txt") / $(wc -l < "$BATCH_DIR/neon-after-sync.txt")"
diff "$BATCH_DIR/neon-before-sync.txt" "$BATCH_DIR/neon-after-sync.txt" | sed -E 's/\|[0-9a-f-]{36}\|/|<owner>|/' || true

echo "── 6. verification including the projection"
npm run --silent import -- archive-verify --batch "$BATCH" --impact "$IMPACT" --fable "$FABLE" --neon-ids "$NEON_IDS" --with-neon | grep -E "^(pass|FAIL|warn)|VERIF|Website"

echo "── 7. idempotency: the same import again must create and update nothing"
npm run --silent import -- archive-seed-events --yes --neon-ids "$NEON_IDS" | grep -E "matched|created"
npm run --silent import -- archive-plan --impact "$IMPACT" --fable "$FABLE" | grep -E "^\| [0-9]+ \||^Decisions"
SECOND="$(latest_batch)"
npm run --silent import -- apply --plan "$SECOND/plan.json" --publish --yes | grep -E '"(created|updated|credits|failed)"'
echo "── done: batch ${BATCH} (manifest ${BATCH_DIR}/apply-manifest.json), second pass ${SECOND}"
