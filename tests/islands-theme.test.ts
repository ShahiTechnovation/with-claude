/**
 * THE REPORT DIALOG AND MODERATOR CONTROLS FOLLOW THE PAGE THEME: no forced light scope, no
 * raw colours, no undefined tokens; they use the forms.css classes. Source checks: the test
 * runner has no DOM.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = [
  'src/components/react/ReportModal.tsx',
  'src/components/react/ModeratorControls.tsx',
  'src/components/ModeratorControls.astro',
];

describe('islands follow the theme', () => {
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    it(`${file} has no hex colour, --ink-5 or data-theme`, () => {
      expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(src).not.toContain('--ink-5');
      expect(src).not.toContain('data-theme=');
    });
  }

  it('the report dialog sets its own ink, since the browser dialog colour would win', () => {
    const modal = readFileSync(files[0], 'utf8');
    expect(modal).toMatch(/<dialog[^>]*color: 'var\(--ink-2\)'/s);
  });

  it('moderator controls use the panel and button classes', () => {
    const controls = readFileSync(files[1], 'utf8');
    for (const cls of [
      '"panel"',
      '"panel-head"',
      '"button button--primary"',
      '"button button--danger"',
    ])
      expect(controls).toContain(cls);
  });

  it('a non-JSON moderator error shows the action and status, not a SyntaxError', () => {
    const controls = readFileSync(files[1], 'utf8');
    expect(controls).toContain('res.json().catch(() => ({}))');
    expect(controls).toContain('Failed to ${action} (${res.status})');
  });

  it('a successful moderator action keeps the buttons disabled while the page reloads', () => {
    const controls = readFileSync(files[1], 'utf8');
    expect(controls).toMatch(/window\.location\.reload\(\);\s*return;/);
    expect(controls).not.toContain('finally');
  });

  it('a moderator network failure says so, and both failures log, not "Error: TypeError"', () => {
    const controls = readFileSync(files[1], 'utf8');
    expect(controls).toContain("alert('We could not reach the server. Try again.')");
    expect(controls.match(/console\.error\(`\[moderator\] \$\{action\} failed`/g)).toHaveLength(2);
  });

  it('the moderator panel takes its own row in the project aside, a wrapping flex row', () => {
    const controls = readFileSync(files[1], 'utf8');
    expect(controls).toContain(
      `className="panel" style={{ marginTop: 'var(--s-5)', width: '100%' }}`,
    );
  });
});
