/**
 * Two admin page decisions with no render harness, so they are read from the page source.
 *
 * /reports/<id> offers Restore for content a moderator has held or taken down, and Restrict for
 * content that is up. Media keeps that state in `status` (`deleted`), not `moderation_state`: before,
 * a report on deleted media offered Restrict again and never Restore, and so did an archived
 * project or builder. The predicate runs here as written.
 *
 * /integrations lists each run's error, the only place a failed run's message lands.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mediaStatus, moderationState } from '../db/schema';

const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('/reports/<id> moderator actions', () => {
  const page = source('admin/src/pages/reports/[id].astro');

  it('reads media state from its status column', () => {
    const start = page.indexOf("report.entityType === 'media'");
    expect(start, 'the media branch moved').toBeGreaterThan(-1);
    expect(page.slice(start, page.indexOf('\n}\n', start))).toContain(
      'moderationState = media.status;',
    );
  });

  it('offers Restore for every held or deleted state and Restrict for the rest', () => {
    const expr = /const held = (.+);/.exec(page)?.[1];
    expect(expr, 'the held predicate moved').toBeDefined();
    const held = new Function('moderationState', `return ${expr};`) as (state: string) => boolean;
    const down = ['restricted', 'archived', 'removed', 'deleted'];
    const up = ['clean', 'reported', 'staged', 'published'];
    // Every value of both state columns is decided here, so a new one has to be placed.
    expect([...moderationState.enumValues, ...mediaStatus.enumValues].sort()).toEqual(
      [...down, ...up].sort(),
    );
    for (const state of down) expect(held(state), state).toBe(true);
    for (const state of up) expect(held(state), state).toBe(false);
    expect(page).toMatch(/\{!held && \(\s*<form\s+method="POST"\s+action=\{`[^`]*\/restrict`\}/);
    expect(page).toMatch(/\{held && \(\s*<form\s+method="POST"\s+action=\{`[^`]*\/restore`\}/);
  });
});

describe('/integrations recent runs', () => {
  it("shows each run's error", () => {
    const page = source('admin/src/pages/integrations/index.astro');
    const start = page.indexOf('<h2>Recent runs</h2>');
    expect(start, 'the Recent runs table moved').toBeGreaterThan(-1);
    const table = page.slice(start, page.indexOf('</table>', start));
    expect(table).toContain('<th>Error</th>');
    expect(table).toContain("<td>{r.error ?? '—'}</td>");
  });
});
