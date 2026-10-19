/**
 * THE REPORT MODAL'S OUTCOMES. On success the open <dialog> is closed before the thank-you
 * replaces it; on a failure a notice says what happened. Either way focus moves to the notice,
 * so keyboard and screen-reader users are not dropped on <body>. A 401 links to the sign-in
 * gate, and only a 403 or 409 shows the server's own sentence. Source checks: the test runner
 * has no DOM.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modal = readFileSync('src/components/react/ReportModal.tsx', 'utf8');
const endpoint = readFileSync('src/pages/api/reports/index.ts', 'utf8');

describe('the report modal', () => {
  it('closes the dialog before showing the thank-you', () => {
    expect(modal).toMatch(/dialogRef\.current\?\.close\(\);\s*setSuccess\(true\);/);
  });

  it('a 401 links to the sign-in gate instead of "session expired"', () => {
    expect(modal).not.toContain('describeAccountError(res)');
    expect(modal).toMatch(/res\.status === 401\)\s*\{\s*setError\('sign-in'\);/);
    expect(modal).toContain('<a href={signInHref(window.location.hostname)}>Sign in</a>');
  });

  it("only a 403 or 409 reads the body, to show the server's sentence", () => {
    expect(modal.match(/res\.json\(\)/g)).toHaveLength(1);
    expect(modal).toMatch(/res\.status === 403 \|\| res\.status === 409 \? await res\.json\(\)/);
    expect(modal).toMatch(/typeof body\?\.error === 'string' \? body\.error/);
  });

  it('other failures and network errors get report copy, not the browser text', () => {
    expect(modal).toContain(`"Couldn't send your report. Try again."`);
    expect(modal).toMatch(
      /catch \{\s*setError\(\{ message: 'We could not reach the server\. Try again\.' \}\);/,
    );
  });

  it('keeps no sentinel string, so the doc block sits on the component', () => {
    expect(modal).not.toContain('SIGN_IN');
    expect(modal).toMatch(/\*\/\nexport function ReportModal\(/);
  });

  it('moves focus to the error notice from an effect, declared before the success return', () => {
    expect(modal).toMatch(/role="alert" tabIndex=\{-1\} ref=\{errorRef\}/);
    expect(modal).toMatch(
      /useEffect\(\(\) => \{\s*if \(error\) errorRef\.current\?\.focus\(\);\s*\}, \[error\]\);/,
    );
    expect(modal.indexOf('useEffect(')).toBeLessThan(modal.indexOf('if (success)'));
  });

  it('clears the last error when the dialog opens', () => {
    expect(modal).toMatch(/setError\(null\);\s*dialogRef\.current\?\.showModal\(\);/);
  });

  it('caps details at the server limit, so a long note is not a generic failure', () => {
    expect(modal).toContain('maxLength={1000}');
    expect(endpoint).toContain('.max(1000)');
  });

  it('the trigger is a flush text link, so its text lines up with the column beside it', () => {
    expect(modal).toMatch(/<button\s+type="button"\s+className="link"\s+onClick=/);
    // The first button with that class is the trigger; the dialog's own buttons stay boxed.
    expect(modal.indexOf('className="link"')).toBeLessThan(modal.indexOf('<dialog'));
  });

  it('moves focus to the thank-you notice', () => {
    expect(modal).toMatch(/role="status"\s*tabIndex=\{-1\}\s*ref=\{\(el\) => el\?\.focus\(\)\}/);
  });
});
