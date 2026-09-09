/**
 * ONE-OFF — archive the production verification residue.
 *
 * `prod-test-builderprod-test-builder` was created on 2026-09-06 by a real
 * pass through `/api/submit` → promote → publish, to verify that pipeline
 * against Neon. It says so itself: `building` reads "Testing production
 * submission pipeline with Neon DB." It is the only record in the database
 * that exists to prove a pipeline works rather than to describe somebody who
 * builds with Claude, and it is the reason `DATA_SOURCE=db` currently renders
 * 73 builders where the TypeScript record holds 71.
 *
 * ── WHY THIS CALLS THE ADMIN'S OWN FUNCTION ──────────────────────────────
 *
 * `transitionContent()` is what the admin's Archive button calls. Going
 * through it rather than issuing an UPDATE means this takedown gets the same
 * guarantees every other takedown gets, none of which are optional:
 *
 *   · the role is checked before the record is read
 *   · `published → archived` is on the map; nothing else is reachable
 *   · the note is required, because a takedown without a reason is not one
 *   · the audit row and the status change commit together, or neither does
 *
 * A hand-written UPDATE would produce the same final status and a gap in the
 * log where the account of it should be. The audit log is the permanent
 * record of this decision — this file is disposable and the log is not.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
 *
 * It deletes nothing. `archive` sets a status; the row, its two existing audit
 * entries and the submission it came from all stay exactly as they are. The
 * public reader simply stops selecting it.
 *
 * The slug guard below is the important line. This script can archive one
 * record and no other: if the row it finds is not the exact test slug, it
 * refuses and exits non-zero. Nothing here can be re-pointed at a real
 * builder by editing an argument, because it takes no arguments.
 *
 *     npx tsx scripts/archive-prod-test-builder.mjs
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { pooledDb } from '../db/pool.ts';
import * as schema from '../db/schema.ts';
import { transitionContent } from '../admin/src/server/publishing.ts';

/** The one record this script is allowed to touch. Not a parameter. */
const TARGET_SLUG = 'prod-test-builderprod-test-builder';

/** The account that created it, and the one taking it down. */
const ACTOR_EMAIL = 'builder7base@gmail.com';

const NOTE =
  'Disposable verification residue: created 2026-09-06 by a production test of the ' +
  'submission → promote → publish pipeline against Neon, not a person building with ' +
  'Claude. Archived rather than deleted so the row, its audit history and the ' +
  'submission it came from all survive. Removes the 73-vs-71 builder discrepancy ' +
  'blocking the DATA_SOURCE=db equivalence check.';

const db = pooledDb();

// The actor, resolved from the database rather than asserted. Role and active
// are read here for the same reason the admin reads them on every request.
const [actorRow] = await db
  .select({
    id: schema.users.id,
    email: schema.users.email,
    role: schema.users.role,
    active: schema.users.active,
  })
  .from(schema.users)
  .where(eq(schema.users.email, ACTOR_EMAIL));

if (!actorRow) {
  console.error(`No admin account for ${ACTOR_EMAIL}. Nothing done.`);
  process.exit(1);
}
if (!actorRow.active) {
  console.error(`${ACTOR_EMAIL} is not active. Nothing done.`);
  process.exit(1);
}

const [target] = await db
  .select({
    id: schema.builders.id,
    slug: schema.builders.slug,
    name: schema.builders.name,
    status: schema.builders.status,
  })
  .from(schema.builders)
  .where(eq(schema.builders.slug, TARGET_SLUG));

if (!target) {
  console.error(`No builder with slug "${TARGET_SLUG}". Nothing done.`);
  process.exit(1);
}

// THE GUARD. Belt and braces: the query above already selected by slug, and
// this refuses anyway, because the cost of being wrong here is somebody's real
// profile disappearing from the site.
if (target.slug !== TARGET_SLUG) {
  console.error(`Refusing: found "${target.slug}", expected "${TARGET_SLUG}".`);
  process.exit(1);
}

if (target.status === 'archived') {
  console.log(`Already archived. Nothing to do.`);
  process.exit(0);
}

console.log(`Archiving  ${target.slug}`);
console.log(`  name     ${JSON.stringify(target.name)}`);
console.log(`  status   ${target.status}`);
console.log(`  actor    ${actorRow.email} (${actorRow.role})`);

const result = await transitionContent(db, {
  entityType: 'builder',
  entityId: target.id,
  action: 'archive',
  actor: { id: actorRow.id, email: actorRow.email, role: actorRow.role },
  note: NOTE,
});

if (!result.ok) {
  console.error(`\nRefused (${result.status}): ${result.error}`);
  process.exit(1);
}

console.log(`\nDone. ${result.from} → ${result.to}`);
console.log(`  audit row  ${result.auditId}`);
console.log(`  deploy     ${JSON.stringify(result.deploy)}`);

// Every audit entry for this record, proving the history was added to and not
// replaced.
const history = await db
  .select({
    createdAt: schema.auditLog.createdAt,
    action: schema.auditLog.action,
    from: schema.auditLog.fromStatus,
    to: schema.auditLog.toStatus,
    actor: schema.auditLog.actorEmail,
  })
  .from(schema.auditLog)
  .where(eq(schema.auditLog.entityId, target.id));

console.log(`\nAudit history for this record (${history.length} rows):`);
for (const row of [...history].sort((a, b) => +a.createdAt - +b.createdAt)) {
  console.log(
    `  ${row.createdAt.toISOString()}  ${row.action.padEnd(18)} ${String(row.from)} → ${String(row.to)}`,
  );
}

process.exit(0);
