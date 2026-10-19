/**
 * THE TWO REACT ISLANDS, RENDERED. `renderToStaticMarkup` runs the components with no DOM, so this
 * pins what a source check can't: which buttons each moderation state gets, and the report dialog
 * as React writes it. The click paths need DOM events; `report-modal.test.ts` and
 * `islands-theme.test.ts` pin those as text. Needs `esbuild: { jsx: 'automatic' }` in
 * vitest.config.ts, the runtime Astro's React integration builds with.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModeratorControls } from '../src/components/react/ModeratorControls';
import { ReportModal } from '../src/components/react/ReportModal';

const controls = (initialState: string) =>
  renderToStaticMarkup(
    createElement(ModeratorControls, { entityType: 'projects', entityId: 'x', initialState }),
  );
// Each button as "class: label".
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map(
    ([, cls, label]) => `${cls}: ${label}`,
  );

describe('the moderator controls', () => {
  it('offer the actions each state allows', () => {
    expect(buttons(controls('clean'))).toEqual([
      'button: Hide (Restrict)',
      'button button--danger: Remove (Delete)',
    ]);
    expect(buttons(controls('restricted'))).toEqual([
      'button button--primary: Restore',
      'button button--danger: Remove (Delete)',
    ]);
    expect(buttons(controls('removed'))).toEqual(['button button--primary: Restore']);
  });
});

describe('the report dialog', () => {
  const html = renderToStaticMarkup(
    createElement(ReportModal, { entityType: 'project', entityId: 'x' }),
  );

  it('is a panel that sets its own ink and forces no theme', () => {
    expect(html).toMatch(/<dialog[^>]*class="panel"[^>]*style="(?:[^"]*;)?color:var\(--ink-2\)/);
    expect(html).not.toContain('data-theme');
  });

  it('caps details at the server limit and offers the nine reasons', () => {
    expect(html).toMatch(/<textarea[^>]*maxLength="1000"/i);
    expect([...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual([
      'spam',
      'impersonation',
      'harassment',
      'inappropriate_content',
      'stolen_work',
      'unsafe_link',
      'copyright',
      'privacy',
      'other',
    ]);
  });
});
