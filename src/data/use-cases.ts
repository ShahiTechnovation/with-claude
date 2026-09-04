import type { UseCase } from './types';

/**
 * CLAUDE IN PRACTICE — the use-case library.
 *
 * Deliberately empty, for the same reason `projects.ts` is: nobody in this
 * community has yet written up how they actually work, and the one thing that
 * would destroy this library's value is filling it with the generic Claude
 * content that already exists everywhere else.
 *
 * The bar for an entry, in order of how often it is the thing that fails:
 *
 *  1. A named author with a credential you could check.
 *  2. A real problem they had, not a demo scenario.
 *  3. What Claude did AND what they did — separately. A record that cannot
 *     name the human contribution is a product demo.
 *  4. A result, including what did not work.
 *
 * "How a Bhopal builder uses Claude Code to prototype products" passes.
 * "10 best Claude Code tips" fails, and no amount of search volume changes
 * that — see the SEO note in the README.
 *
 * The library UI is complete and renders its open state from this array being
 * empty. Add one real, attributed entry and the index takes over.
 *
 * TODO: interview the Claude Code workshop leads (vol. 09) and the Impact Lab
 * mentors — they have run these workflows in front of a room, which is the
 * strongest possible credential and the easiest write-up to verify.
 */
export const useCases: UseCase[] = [];
