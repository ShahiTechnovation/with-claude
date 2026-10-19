/**
 * THE MEMBER EDITORS' SMALL GAPS (batch 006: F46-F50, then T34-T38 in round F3).
 *
 * Source assertions, as in privy-ui.test.ts: the editors need a Privy session
 * to render, so these pin the lines that close each gap. Each source is read
 * with every run of whitespace collapsed to one space, so a prettier rewrap
 * doesn't break a pin.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMAGE_HINT, IMAGE_TYPES, MAX_IMAGE_BYTES } from '../src/components/react/upload-image';
import { ALLOWED_COVER_TYPES, MAX_COVER_BYTES } from '../src/server/media/covers';

const source = (path: string) => readFileSync(path, 'utf8').replace(/\s+/g, ' ');
const profile = source('src/components/react/ProfileEditor.tsx');
const project = source('src/components/react/ProjectEditor.tsx');
const editors = [
  ['ProfileEditor', profile],
  ['ProjectEditor', project],
];

describe('the profile editor', () => {
  it('labels the status badge from the saved visibility, like the hint beside it', () => {
    const badge = profile.slice(profile.indexOf('status-badge--'), profile.indexOf('panel-hint'));
    expect(badge).toContain("saved.visibility === 'unlisted'");
    expect(badge).not.toContain('form.visibility');
  });

  it('types visibility as its two values, so a misspelt comparison does not compile', () => {
    expect(profile).toContain("visibility: 'public' | 'unlisted';");
  });

  it('ties the Claude tools error to its input', () => {
    expect(profile).toMatch(/id="pe-tools"[^>]*aria-describedby=\{describedBy\('claudeSince'\)\}/);
  });

  it('refuses to blank a saved username instead of showing it as saved', () => {
    const save = profile.slice(
      profile.indexOf('const savePassport'),
      profile.indexOf('const onSave'),
    );
    const guard = save.indexOf('if (saved.username && !form.username.trim()) {');
    expect(guard).toBeGreaterThan(-1);
    // Before the PATCH, with the readiness list's wording, focusing the field and not saving.
    expect(guard).toBeLessThan(save.indexOf('account.fetch('));
    expect(save.slice(guard, save.indexOf('const body'))).toContain(
      "focusId.current = 'pe-username'; setFieldErrors({ username: 'Choose a username' }); return false;",
    );
    expect(profile).toContain("!f.username.trim() && 'Choose a username'");
  });

  it('turns off Remove portrait while busy', () => {
    expect(profile).toContain(
      "disabled={busy !== null} onClick={() => set('avatarMediaId', null)}",
    );
  });

  it('reads out the failed city list hint with the select', () => {
    expect(profile).toContain('const cityListFailed = cities !== null && cities.length === 0;');
    expect(profile).toContain("aria-describedby={describedBy('citySlug', cityListFailed)}");
    expect(profile).toMatch(
      /id="pe-citySlug-hint"> ?The city list could not be loaded\. Reload to try again\./,
    );
  });
});

describe('the project editor', () => {
  it('keeps a saved city selected when the city list lacks it', () => {
    expect(project).toContain(
      '{form.cityId && cities !== null && !cities.some((c) => c.id === form.cityId) && (',
    );
    expect(project).toContain('<option value={form.cityId}>Current city</option>');
  });

  it('says when the city list failed to load, and reads it out with the select', () => {
    expect(project).toContain('const cityListFailed = cities !== null && cities.length === 0;');
    expect(project).toContain("{...aria('cityId', cityListFailed)}");
    // field()'s hint argument, which renders as pj-cityId-hint.
    expect(project).toContain(
      "</select>, cityListFailed ? 'The city list could not be loaded. Reload to try again.' : undefined",
    );
  });

  it('turns off Remove share image while saving or uploading', () => {
    expect(project).toContain("disabled={disabled} onClick={() => set('coverMediaId', null)}");
    expect(project).toContain('const disabled = busy !== null || !editable || sessionGone;');
  });

  it('moves focus to the name when it is too short to save', () => {
    expect(project).toContain(
      "if (form.title.trim().length < 2) { focusId.current = 'pj-title'; setFieldErrors",
    );
  });
});

describe('both editors', () => {
  it.each(editors)('%s says a failed image confirm is a connection problem', (_name, editor) => {
    expect(editor).toContain(
      "error instanceof UploadProblem ? error.message : 'We could not reach the server. Try again.'",
    );
    expect(editor).not.toContain('could not be uploaded.');
  });

  it.each(editors)('%s takes its image picker and hint from upload-image', (_name, editor) => {
    expect(editor).toContain('accept={IMAGE_ACCEPT}');
    expect(editor).toContain(' · {IMAGE_HINT}');
    expect(editor).not.toContain('image/jpeg');
    expect(editor).not.toContain('JPEG, PNG');
  });
});

describe('the image types the editors offer', () => {
  it('are the types and size the server accepts', () => {
    expect(IMAGE_TYPES).toEqual([...ALLOWED_COVER_TYPES]);
    expect(MAX_IMAGE_BYTES).toBe(MAX_COVER_BYTES);
  });

  it('are all named in the hint, with the size', () => {
    for (const type of IMAGE_TYPES) {
      expect(IMAGE_HINT.toLowerCase()).toContain(type.replace('image/', ''));
    }
    expect(IMAGE_HINT).toContain(`up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  });
});
