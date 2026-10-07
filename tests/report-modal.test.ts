/**
 * THE REPORT MODAL'S SUCCESS STATE: the open <dialog> is closed before the thank-you
 * replaces it, and focus moves to the thank-you, so keyboard and screen-reader users are
 * not dropped on <body>. Source checks: the test runner has no DOM.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modal = readFileSync('src/components/react/ReportModal.tsx', 'utf8');

describe('the report modal', () => {
  it('closes the dialog before showing the thank-you', () => {
    expect(modal).toMatch(/dialogRef\.current\?\.close\(\);\s*setSuccess\(true\);/);
  });

  it('moves focus to the thank-you notice', () => {
    expect(modal).toMatch(/role="status"\s*tabIndex=\{-1\}\s*ref=\{\(el\) => el\?\.focus\(\)\}/);
  });
});
