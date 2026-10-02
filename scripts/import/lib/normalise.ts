/**
 * NORMALISATION AND IDENTITY for imported projects.
 *
 * The importer must recognise the same project across a re-run and across a
 * REVISED spreadsheet, and must never merge two different projects because
 * they share a name. So identity is built, in order of strength, from:
 *
 *   1. a genuine submission id from the form tool           (strong)
 *   2. the event plus a normalised artifact URL (repo, live, video)  (strong)
 *   3. the event plus normalised title AND team name        (weak → review)
 *
 * Never a row number, never a title alone. A weak identity is allowed to
 * create a draft, but it is always listed for a person to confirm.
 */
import { createHash } from 'node:crypto';

/** Collapse whitespace, strip zero-width and control characters. */
export function cleanText(value: string | undefined | null): string {
  return (value ?? '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** For identity comparison only — never for display. */
export function identityText(value: string | undefined | null): string {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A display URL, or null with the reason. Bare domains get https:// added
 * (people type `github.com/x`); anything that is not http(s) after that is
 * invalid — `javascript:` and `mailto:` included.
 */
export function cleanUrl(value: string | undefined | null): { url: string | null; invalid?: string } {
  const raw = cleanText(value);
  if (!raw) return { url: null };
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { url: null, invalid: raw };
    if (!u.hostname.includes('.') || u.username || u.password) return { url: null, invalid: raw };
    if (candidate.length > 500) return { url: null, invalid: raw.slice(0, 60) };
    return { url: u.toString() };
  } catch {
    return { url: null, invalid: raw.slice(0, 120) };
  }
}

/**
 * The comparison form of an artifact URL: scheme-less, `www.`-less, lower-case
 * host, no trailing slash or `.git`, no fragment, and no query — tracking
 * params differ between copies of the same link — EXCEPT the parameter that
 * IS the identity on hosts that put it there. `drive.google.com/open?id=A` and
 * `?id=B` are different files, and `youtube.com/watch?v=…` different videos;
 * dropping those made every Drive "open" link and every YouTube watch link
 * look like the same artifact. `youtu.be/<id>` and `/watch?v=<id>` agree.
 */
export function artifactKey(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');
    const path = u.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    const lowerPath = /(^|\.)github\.com$|(^|\.)gitlab\.com$/.test(host) ? path.toLowerCase() : path;
    if (host === 'youtube.com' && path === '/watch' && u.searchParams.get('v')) return `youtube:${u.searchParams.get('v')}`;
    if (host === 'youtu.be' && path.length > 1) return `youtube:${path.slice(1)}`;
    if (host === 'drive.google.com') {
      const id = u.searchParams.get('id') ?? path.match(/\/d\/([^/]+)/)?.[1];
      if (id) return `drive:${id}`;
    }
    return `${host}${lowerPath}`;
  } catch {
    return null;
  }
}

export function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export type IdentityStrength = 'submission' | 'artifact' | 'title-team';

export function candidateIdentity(input: {
  eventKey: string;
  submissionId?: string | null;
  artifacts: (string | null)[];
  title: string;
  teamName?: string | null;
}): { key: string; strength: IdentityStrength; basis: string } {
  const submission = cleanText(input.submissionId);
  if (submission) {
    return { key: sha(`${input.eventKey}|sub|${submission.toLowerCase()}`), strength: 'submission', basis: `submission ${submission}` };
  }
  const artifact = input.artifacts.map(artifactKey).find(Boolean);
  if (artifact) {
    return { key: sha(`${input.eventKey}|art|${artifact}`), strength: 'artifact', basis: artifact };
  }
  const title = identityText(input.title);
  const team = identityText(input.teamName);
  return {
    key: sha(`${input.eventKey}|tt|${title}|${team}`),
    strength: 'title-team',
    basis: `title "${title}"${team ? ` + team "${team}"` : ' (no team name)'}`,
  };
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(?:\+?\d[\s-]?){9,}/;

/** True when a value that is about to become PUBLIC looks like contact data. */
export function looksPrivate(value: string): boolean {
  return EMAIL.test(value) || PHONE.test(value);
}

/** Mask contact-looking values for terminal output during `inspect`. */
export function maskForDisplay(value: string): string {
  return value.replace(new RegExp(EMAIL.source, 'g'), '«email»').replace(new RegExp(PHONE.source, 'g'), '«phone»');
}
