/**
 * THE CONTROLLED VOCABULARY FOR "WHAT YOU DO".
 *
 * One list, imported by both sides of the profile-edit boundary:
 *
 *   `src/server/members/profile.ts`   validates a PATCH against this exact
 *                                     enum via `z.enum(SELECTABLE_ROLES)`
 *   `src/components/react/ProfileEditor.tsx`  populates the "What you do"
 *                                     `<select>` with the same values
 *
 * It used to be defined ONLY on the server, and the client rendered a free-
 * text `<input>` for the same field. That let a member type anything —
 * including an empty string, which every profile starts with — and the
 * server's enum check rejected it every time. A dropdown that offers exactly
 * the values the server accepts is what makes the two agree by construction
 * rather than by two people remembering to keep two lists in sync.
 *
 * §15's list: a role a person can claim about themselves, and specifically
 * not a role that implies verified standing. `ambassador` is refused for
 * that reason — see `PROTECTED_ROLE_WORDS` in `src/server/members/profile.ts`,
 * which still catches it in free text (`headline`, `bio`) even though this
 * field no longer takes free text at all.
 *
 * Dependency-free on purpose: `src/server/members/profile.ts` imports
 * `db/schema`, `drizzle-orm` and a database-backed username check, none of
 * which may reach a browser bundle. This file imports nothing, so either side
 * can import it without dragging the other's dependencies along.
 */
export const SELECTABLE_ROLES = [
  'Founder',
  'Developer',
  'Designer',
  'Researcher',
  'Student',
  'Creator',
  'Product',
  'Marketer',
  'Operator',
  'Investor',
  'Educator',
] as const;

export type SelectableRole = (typeof SELECTABLE_ROLES)[number];
