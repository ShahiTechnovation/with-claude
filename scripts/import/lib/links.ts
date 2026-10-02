/**
 * LINKS IN SUBMISSION CELLS — extracted, classified, never trusted.
 *
 * A form field called "live project" holds whatever the team typed: a
 * deployment, a repository, a release page, a Drive file, a person's name, a
 * sentence with a URL in it, the same URL pasted twice, or a link that carries
 * a secret. This module turns one cell into typed candidates and explicit
 * rejections, and decides nothing editorial: the source adapter picks the
 * primary link of each kind and records every repair it made.
 *
 * Hard rules, enforced here so no caller can forget them:
 *
 *   · A URL with a credential-looking query parameter (`key`, `token`, …) or
 *     an admin route is REJECTED WHOLE. It is never returned, logged or put
 *     in a report — the caller gets only the reason, and should cite the cell
 *     coordinate. Removing the query would not make an admin route a demo.
 *   · Loopback, private and link-local hosts are rejected before anything
 *     could ever fetch them.
 *   · `_vercel_share` (a Vercel access grant) is removed, and the clean URL is
 *     flagged as needing verification — not assumed public.
 *   · Nothing here makes a network request.
 */

export type LinkKind = 'live' | 'repo' | 'video' | 'download' | 'artifact' | 'post' | 'profile';

export type LinkFlag =
  /** `https://` was added to a scheme-less domain. */
  | 'scheme-added'
  /** `owner/repo` shorthand expanded to a GitHub URL. Unverified. */
  | 'shorthand-repo'
  /** A README/blob link reduced to the repository it belongs to. */
  | 'readme-to-repo'
  /** An access-granting parameter was removed. The clean URL is unverified. */
  | 'access-param-removed'
  /** A temporary tunnel (ngrok, trycloudflare). Likely to stop working. */
  | 'tunnel'
  /** Trailing junk (a backslash, a bracket) removed. */
  | 'trimmed'
  /** Found inside prose rather than as the whole cell. */
  | 'embedded';

export interface ClassifiedLink {
  url: string;
  kind: LinkKind;
  host: string;
  flags: LinkFlag[];
}

export type RejectionReason =
  | 'credential-bearing'
  | 'admin-route'
  | 'private-host'
  | 'hosting-dashboard'
  | 'not-a-url'
  | 'invalid-url';

export interface CellLinks {
  links: ClassifiedLink[];
  rejected: RejectionReason[];
  /** The cell had text that was not a link (a name, "NA", a sentence). */
  nonLinkText: boolean;
  /** The same URL appeared more than once in the cell. */
  duplicatedInCell: boolean;
}

/** The kind of form field the cell came from — it decides ambiguous cases. */
export type FieldRole = 'live' | 'repo' | 'video' | 'attachment' | 'showcase';

const CREDENTIAL_PARAM = /^(key|apikey|api[_-]?key|token|access[_-]?token|auth|secret|password|passwd|pass|sig|signature|session|sessionid|code)$/i;
const ACCESS_PARAM = /^_vercel_share$/i;
const TUNNEL_HOST = /(^|\.)(trycloudflare\.com|ngrok-free\.(dev|app)|ngrok\.(io|app)|loca\.lt|serveo\.net)$/i;
/** TLDs that appear in these submissions as bare domains. Deliberately short. */
const BARE_TLD = 'com|in|dev|app|io|me|ai|tech|fun|net|org|co|xyz|so|page|site|link|cc';
const URL_IN_TEXT = new RegExp(
  String.raw`https?:\/\/[^\s{}()<>"'\`]+|(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${BARE_TLD})(?![a-z0-9-])(?:\/[^\s{}()<>"'\`]*)?`,
  'gi',
);
const SHORTHAND_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (h.includes(':')) {
    // IPv6 literal: unique-local, link-local, mapped v4.
    return /^(fc|fd|fe8|fe9|fea|feb)/i.test(h) || h.startsWith('::ffff:');
  }
  return false;
}

/** Pull URL-ish tokens out of free text, splitting pasted-twice URLs apart. */
export function extractUrlTokens(text: string): { tokens: string[]; embedded: boolean; duplicated: boolean } {
  const raw = text.trim();
  const matches = raw.match(URL_IN_TEXT) ?? [];
  const tokens: string[] = [];
  for (const match of matches) {
    // "https://a…https://a…" — one token, two URLs.
    const parts = match.split(/(?=https?:\/\/)/i).filter(Boolean);
    tokens.push(...parts);
  }
  const embedded = tokens.length > 0 && tokens.join('').length < raw.replace(/[\s,]+/g, '').length;
  const normalised = tokens.map((t) => t.toLowerCase().replace(/[\\/.,;:)\]}'"]+$/g, ''));
  const duplicated = new Set(normalised).size < normalised.length;
  return { tokens, embedded, duplicated };
}

function trimToken(token: string): { value: string; trimmed: boolean } {
  const value = token.replace(/[\\.,;:!?)\]}'"]+$/g, '');
  return { value, trimmed: value.length !== token.length && /\\/.test(token.slice(value.length)) };
}

function videoHost(u: URL): boolean {
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'loom.com' || host === 'vimeo.com') return true;
  if (host === 'docs.google.com' && u.pathname.startsWith('/videos/')) return true;
  if (host.endsWith('dropbox.com') && /\.(mov|mp4|webm|m4v)$/i.test(u.pathname)) return true;
  return false;
}

/**
 * Classify one absolute URL from a given field. Returns a rejection reason
 * instead of a link when the URL must not be used at all.
 */
export function classifyUrl(input: string, role: FieldRole): ClassifiedLink | RejectionReason {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return 'invalid-url';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'invalid-url';
  if (u.username || u.password) return 'credential-bearing';
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') && !host.includes(':')) return isPrivateHost(host) ? 'private-host' : 'invalid-url';
  if (isPrivateHost(host)) return 'private-host';

  const flags: LinkFlag[] = [];
  for (const name of [...u.searchParams.keys()]) {
    if (CREDENTIAL_PARAM.test(name)) return 'credential-bearing';
  }
  if (/(^|\/)admin(\/|$)/i.test(u.pathname)) return 'admin-route';
  for (const name of [...u.searchParams.keys()]) {
    if (ACCESS_PARAM.test(name)) {
      u.searchParams.delete(name);
      flags.push('access-param-removed');
    }
  }
  if (TUNNEL_HOST.test(host)) flags.push('tunnel');

  const bare = host.replace(/^www\./, '');
  const segments = u.pathname.split('/').filter(Boolean);
  const out = (kind: LinkKind): ClassifiedLink => ({ url: u.toString(), kind, host: bare, flags });

  // A hosting provider's own dashboard is never a public demo.
  if (bare === 'vercel.com' || bare === 'dashboard.render.com' || bare === 'app.netlify.com' || bare === 'railway.app') {
    return 'hosting-dashboard';
  }

  if (bare === 'github.com') {
    if (segments.length === 0) return 'invalid-url';
    if (segments.length === 1) return out('profile');
    const [owner, repoRaw, section] = segments;
    const repo = repoRaw.replace(/\.git$/i, '');
    if (section === 'releases') return out('download');
    if (section === 'blob' && /readme(\.md)?$/i.test(segments[segments.length - 1] ?? '')) {
      u.pathname = `/${owner}/${repo}`;
      u.search = '';
      flags.push('readme-to-repo');
      return out('repo');
    }
    if (repo !== repoRaw) u.pathname = `/${[owner, repo, ...segments.slice(2)].join('/')}`;
    return out('repo');
  }
  if (bare.endsWith('.github.io')) return out('live');
  if (bare === 'huggingface.co' && segments[0] === 'spaces') return out('artifact');
  if (bare === 'x.com' || bare === 'twitter.com') return segments.includes('status') ? out('post') : out('profile');
  if (bare === 'lnkd.in') return out('post');
  if (bare === 'linkedin.com') return segments[0] === 'feed' || segments[0] === 'posts' ? out('post') : out('profile');
  if (videoHost(u)) return out('video');
  if (bare === 'drive.google.com') {
    // A recording uploaded to Drive, or a folder of demo files: a demo when
    // it was submitted as one, otherwise an attachment.
    return out(role === 'video' ? 'video' : 'artifact');
  }
  if (bare === 'docs.google.com' || bare === 'canva.link' || bare === 'canva.com') return out('artifact');
  return out('live');
}

/**
 * Every link in one cell. `role` is the field the team typed it into, which
 * resolves ambiguous cases and permits `owner/repo` shorthand in repo fields.
 */
export function linksInCell(value: string | null | undefined, role: FieldRole): CellLinks {
  const text = (value ?? '').trim();
  const result: CellLinks = { links: [], rejected: [], nonLinkText: false, duplicatedInCell: false };
  if (!text) return result;

  const shorthand = role === 'repo' ? text.match(SHORTHAND_REPO) : null;
  if (shorthand && !/\.(com|in|dev|app|io|me|ai)$/i.test(shorthand[1])) {
    const link = classifyUrl(`https://github.com/${shorthand[1]}/${shorthand[2].replace(/\.git$/i, '')}`, 'repo');
    if (typeof link !== 'string') {
      link.flags.push('shorthand-repo');
      result.links.push(link);
    }
    return result;
  }

  const { tokens, embedded, duplicated } = extractUrlTokens(text);
  result.duplicatedInCell = duplicated;
  if (tokens.length === 0) {
    result.nonLinkText = true;
    result.rejected.push('not-a-url');
    return result;
  }
  if (embedded) result.nonLinkText = true;
  const seen = new Set<string>();
  for (const token of tokens) {
    const { value, trimmed } = trimToken(token);
    const hasScheme = /^https?:\/\//i.test(value);
    const link = classifyUrl(hasScheme ? value : `https://${value}`, role);
    if (typeof link === 'string') {
      result.rejected.push(link);
      continue;
    }
    if (!hasScheme) link.flags.push('scheme-added');
    if (trimmed) link.flags.push('trimmed');
    if (embedded) link.flags.push('embedded');
    const key = comparableUrl(link.url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.links.push(link);
  }
  return result;
}

/** Comparison form: host without www, path without trailing slash / `.git`, no query. */
export function comparableUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    if (host === 'github.com') path = path.toLowerCase();
    // Drive's `open?id=` and `file/d/<id>` are the same file.
    const driveId = host === 'drive.google.com' ? (u.searchParams.get('id') ?? path.match(/\/d\/([^/]+)/)?.[1]) : null;
    return driveId ? `drive:${driveId}` : `${host}${path}`;
  } catch {
    return url;
  }
}
