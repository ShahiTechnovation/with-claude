/**
 * Create or update an editorial account.
 *
 *   npm run db:create-user -- --email you@example.com --name "Your Name" --role admin
 *   npm run db:create-user -- --email them@example.com --role editor
 *   npm run db:create-user -- --email them@example.com --deactivate
 *
 * ── WHY THIS IS A COMMAND AND NOT A SCREEN ───────────────────────────────
 *
 * Access to the admin is the whole security boundary of this project. A web
 * form that grants it — even one behind a login — is a form that can be
 * reached by a stolen session, a CSRF hole or a bug in a role check. A command
 * can only be run by somebody who already has the production database
 * credentials, which is a much smaller set of people than "anybody who is
 * signed in", and it leaves a shell history rather than nothing.
 *
 * There is no sign-up anywhere in this system. `admin.withclaude.in/login`
 * checks this table and sends nothing to an address it does not find.
 *
 * ── NO REAL ADDRESSES IN THE REPOSITORY ──────────────────────────────────
 *
 * Nobody's email is committed. Accounts are created by running this against
 * the real database, and the only place an address is written down is the
 * `users` table itself.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { pooledDb } from './pool';
import * as schema from './schema';

/** The two roles the admin recognises. `viewer` exists but cannot sign in. */
const ROLES = ['admin', 'editor'] as const;
type Role = (typeof ROLES)[number];

interface Args {
  email?: string;
  name?: string;
  role?: string;
  deactivate?: boolean;
  activate?: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--email':
        args.email = argv[++i];
        break;
      case '--name':
        args.name = argv[++i];
        break;
      case '--role':
        args.role = argv[++i];
        break;
      case '--deactivate':
        args.deactivate = true;
        break;
      case '--activate':
        args.activate = true;
        break;
      default:
        if (flag?.startsWith('--')) {
          throw new Error(`Unknown flag "${flag}".`);
        }
    }
  }
  return args;
}

const USAGE = `
Create or update an editorial account.

  npm run db:create-user -- --email <address> [--name <name>] [--role admin|editor]
  npm run db:create-user -- --email <address> --deactivate
  npm run db:create-user -- --email <address> --activate

Running it for an address that already exists updates that account rather than
creating a second one. Deactivating takes effect on that person's very next
request, not when their session expires.
`.trim();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email) {
    console.error(USAGE);
    process.exit(1);
  }

  const email = args.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    console.error(`"${args.email}" does not look like an email address.`);
    process.exit(1);
  }

  if (args.role && !(ROLES as readonly string[]).includes(args.role)) {
    console.error(`--role must be one of: ${ROLES.join(', ')}. Got "${args.role}".`);
    process.exit(1);
  }

  if (args.deactivate && args.activate) {
    console.error('Pick one of --deactivate or --activate.');
    process.exit(1);
  }

  const db = pooledDb();
  const [existing] = await db
    .select({ id: schema.users.id, role: schema.users.role, active: schema.users.active })
    .from(schema.users)
    .where(eq(schema.users.email, email));

  const active = args.deactivate ? false : args.activate ? true : undefined;

  if (existing) {
    const [updated] = await db
      .update(schema.users)
      .set({
        // Only what was asked for. Omitting --role leaves the role alone,
        // so reactivating somebody cannot silently change what they can do.
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.role !== undefined ? { role: args.role as Role } : {}),
        ...(active !== undefined ? { active } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, existing.id))
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        active: schema.users.active,
      });

    console.log(
      `Updated ${updated.email} — role ${updated.role}, ` +
        `${updated.active ? 'active' : 'DEACTIVATED'}${updated.name ? `, ${updated.name}` : ''}`,
    );
    return;
  }

  if (active === false) {
    console.error(`No account for ${email}, so there is nothing to deactivate.`);
    process.exit(1);
  }

  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      name: args.name ?? null,
      // An account with no role stated is an editor, not an admin. The
      // stronger permission is always the one you have to ask for.
      role: (args.role as Role) ?? 'editor',
      active: true,
    })
    .returning({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
    });

  console.log(
    `Created ${created.email} — role ${created.role}${created.name ? `, ${created.name}` : ''}`,
  );
  console.log('They can now request a sign-in link at the admin. No password is set or needed.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
