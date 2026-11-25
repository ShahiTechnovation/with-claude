/**
 * SOURCE — the Fable 5.2 Build Day submission form (Bhopal, 22 Nov 2026).
 *
 *   `Bhopal _ Fable 5.2 Build Day Project Submission (Responses).xlsx`, one
 *   Google Form export (`claude-build-day-22-november`).
 *
 * The October adapter reads it (`../impact-lab-2026-10/index.ts`); this file
 * is only what differs: the verified headers, the checksum, where each field
 * sits, the card line, the decisions and the report's words. The commands are
 * `build-day-nov-*` (`../impact-lab-2026-10/commands.ts`).
 *
 * Private by construction:
 *
 *   · Email columns (B, D, G, I, K, M) and the "anything else" notes (AC) are
 *     never read: some AC cells hold test logins for the teams' apps.
 *   · Member names (C, F, H, J, L) are read in memory only, as October's are.
 *   · Team size (N), timestamps (A) and the four confirmations (Y–AB) stay
 *     private review evidence.
 */
import type { LabForm } from '../impact-lab-2026-10/index';
import { BUILD_DAY_NOVEMBER_DECISIONS } from './editorial';

const SOURCE = {
  label: 'Bhopal | Fable 5.2 Build Day',
  event: 'Fable 5.2 Build Day',
  eventSlug: 'claude-build-day-22-november',
  eventKey: 'evt-bhopal-fable-5-2-build-day-2026-11',
  heldOn: '2026-11-22',
  sheet: 'Form responses 1',
  checksum: '42eeee6257cdb13036e59990cbd2f65c98a362faeaf3ac181486d498a3d918c2',
  headers: {
    0: 'timestamp',
    1: 'email address',
    2: 'team member 1',
    3: 'member 1 email',
    4: 'team name',
    5: 'member 2 name',
    6: 'member 2 email',
    7: 'member 3 name',
    8: 'member 3 email',
    9: 'member 4 name',
    10: 'member 4 email',
    11: 'member 5 name',
    12: 'member 5 email',
    13: 'number of team members',
    14: 'project name',
    15: 'which track did you pick',
    16: 'what problem',
    17: 'tell us about your solution',
    18: 'what did you build it with',
    19: 'how did you use fable 5.2',
    20: 'project link',
    21: 'live or deployed project',
    22: 'demo video link',
    23: 'demo video (optional)',
    24: 'built today',
    25: 'our work',
    26: 'everything works',
    27: 'final confirmation',
    28: 'anything else',
  } as Record<number, string>,
  emailColumns: [1, 3, 6, 8, 10, 12],
  nameColumns: [2, 5, 7, 9, 11],
  lastColumn: 'AC',
} as const;

/** The project-card line the static record carries. */
export const BUILT_AT = 'Built at Fable 5.2 Build Day · 22 Nov 2026';

export const BUILD_DAY_NOVEMBER: LabForm = {
  id: 'build-day-2026-11',
  prefix: 'build-day-nov',
  file: 'Bhopal _ Fable 5.2 Build Day Project Submission (Responses).xlsx',
  source: SOURCE,
  unread: [28],
  columns: {
    timestamp: 0,
    team: 4,
    size: 13,
    title: 14,
    track: 15,
    problem: 16,
    solution: 17,
    stack: 18,
    usage: 19,
    // U is "Project link (GitHub repo, gist or deployed URL)": a deployment
    // there is still published as the live link.
    repo: [20],
    live: [21],
    // W and X are one video field: the first link is the demo, the next the second video.
    video: [22, 23],
    confirmations: [24, 25, 26, 27],
  },
  builtAt: BUILT_AT,
  // The tag is P's text before the colon: the full options run 44–50 characters (decided
  // 2026-11-24, 18:05). Searched, never shown.
  trackTags: {
    'Breakthrough: something you could not build before': 'Breakthrough',
    'Delight: something surprising, beautiful or fun': 'Delight',
    'Everyday: solves a real problem in your life': 'Everyday',
  },
  decisions: BUILD_DAY_NOVEMBER_DECISIONS,
  report: {
    title: 'Fable 5.2 Build Day import — reconciliation report',
    basis: [
      'Confirmed by Vishal 2026-11-24, 16:36: "Yes, with team names" — the Build Day builders agreed to their projects being public, with team names. Member names and emails stay private: this import creates no person credits.',
      'Editorial answers confirmed by Vishal 2026-11-24, 16:58: the editorial table as written, the track (P) kept as a tag, and row 18 held. At 18:05 the tag became the short track name (Delight, Breakthrough or Everyday), kept for search and never shown. The form’s four confirmations (Y–AB) are not a permission to publish.',
    ],
    withheld: (labels) => [
      '- Every email column (B, D, G, I, K, M) and the "anything else" notes (AC) — never read by the adapter.',
      '- Member names (C, F, H, J, L) — read in memory only, to count the roster and to refuse any output that contains one. No person credit is created.',
      `- Team labels that are not a publishable team name: ${labels}.`,
      '- Team size (N), submission timestamps (A) and the four confirmations (Y–AB) — private review evidence.',
    ],
    withheldColumns:
      'emails (B, D, G, I, K, M), notes (AC, never read), member names (C, F, H, J, L), team size (N), timestamps (A), confirmations (Y–AB)',
    out: 'docs/imports/2026-11-build-day.md',
    ts: '.batches/019-build-day-content/projects-entries.ts',
  },
};
