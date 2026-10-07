/**
 * PROJECT DISPLAY — labels and text shaping shared by the directory row, the
 * project page and the event page. Pure functions, so they are tested and so
 * no two templates word the same fact differently.
 */
import { formatName } from './status';

export type BuildStatusValue = 'functional' | 'partial' | 'prototype';

export const BUILD_STATUS_LABEL: Record<BuildStatusValue, string> = {
  functional: 'Functional',
  partial: 'Partially functional',
  prototype: 'Prototype',
};

/** Always marked as the team's own claim; there is no label for "unknown". */
export function buildStatusLabel(status: BuildStatusValue | null | undefined): string | null {
  return status ? BUILD_STATUS_LABEL[status] : null;
}

export function categoryLabel(category: string): string {
  return category === 'developer-tool' ? 'Developer tool' : formatName(category);
}

/** Import-generated summaries ("Built at X · 20 Sep 2026") repeat the event badge. */
export function ownSummary(summary: string | null | undefined): string | undefined {
  const s = summary?.trim();
  return s && !/^(Built|Submitted) at .+ · \d{1,2} [A-Z][a-z]{2} \d{4}$/.test(s) ? s : undefined;
}

export type ArtifactKind = 'live' | 'repo' | 'video' | 'altVideo' | 'download' | 'artifact';

export interface ArtifactAction {
  kind: ArtifactKind;
  href: string;
  /** The verb phrase on a button: "View live demo". */
  label: string;
  /** A short form for dense rows: "Live". */
  short: string;
  /** Where it goes, for the accessible name and a muted suffix. */
  host: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** A typed link → an honest label. Only http(s) links are ever returned. */
export function artifactAction(
  kind: ArtifactKind,
  href: string | null | undefined,
): ArtifactAction | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  const host = hostOf(href);
  const path = pathOf(href);
  const drive = host === 'drive.google.com';
  switch (kind) {
    case 'live':
      return { kind, href, label: 'View live demo', short: 'Live', host };
    case 'repo':
      return host === 'github.com'
        ? { kind, href, label: 'GitHub repository', short: 'Repo', host }
        : { kind, href, label: 'Source repository', short: 'Repo', host };
    case 'video':
    case 'altVideo': {
      const second = kind === 'altVideo';
      if (drive && path.includes('/folders/')) {
        return {
          kind,
          href,
          label: second ? 'Second demo (Drive folder)' : 'Demo files (Drive folder)',
          short: 'Demo',
          host,
        };
      }
      const where =
        host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com'
          ? 'YouTube'
          : host === 'loom.com'
            ? 'Loom'
            : drive || host === 'docs.google.com'
              ? 'Google Drive'
              : host.endsWith('dropbox.com')
                ? 'Dropbox'
                : '';
      return {
        kind,
        href,
        label: `${second ? 'Watch second demo' : 'Watch demo'}${where ? ` (${where})` : ''}`,
        short: 'Video',
        host,
      };
    }
    case 'download':
      return {
        kind,
        href,
        label: host === 'github.com' ? 'Download (GitHub release)' : 'Download',
        short: 'Download',
        host,
      };
    case 'artifact': {
      const label =
        host === 'docs.google.com' && path.startsWith('/presentation')
          ? 'View slides'
          : host === 'huggingface.co'
            ? 'Hugging Face Space'
            : host === 'canva.link' || host === 'canva.com'
              ? 'View Canva presentation'
              : drive
                ? path.includes('/folders/')
                  ? 'Submission files (Drive folder)'
                  : 'Submission file (Google Drive)'
                : 'View artifact';
      return { kind, href, label, short: 'Artifact', host };
    }
  }
}

/** Every artifact action for a project, primary first, absent ones omitted. */
export function artifactActions(p: {
  url?: string | null;
  repoUrl?: string | null;
  videoUrl?: string | null;
  altVideoUrl?: string | null;
  downloadUrl?: string | null;
  artifactUrl?: string | null;
}): ArtifactAction[] {
  return [
    artifactAction('live', p.url),
    artifactAction('repo', p.repoUrl),
    artifactAction('video', p.videoUrl),
    artifactAction('download', p.downloadUrl),
    artifactAction('altVideo', p.altVideoUrl),
    artifactAction('artifact', p.artifactUrl),
  ].filter((a): a is ArtifactAction => Boolean(a));
}

// ── narrative ────────────────────────────────────────────────────────────

/** A run of inline text; `strong` marks `**bold**`, `em` marks `*emphasis*` from the submission. */
export interface Inline {
  text: string;
  strong?: boolean;
  em?: boolean;
}

export type Block =
  | { type: 'p'; content: Inline[] }
  | { type: 'h'; content: Inline[] }
  | { type: 'ul'; items: Inline[][] };

/**
 * `*emphasis*` only when the asterisks hug the words and sit at word
 * boundaries — so "5 * 3 * 4" and a stray "*x" are left exactly as typed.
 */
const EMPHASIS = /(?<=^|[\s(“"'])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,;:!?”"'])/g;

function inline(text: string): Inline[] {
  const out: Inline[] = [];
  for (const part of text.split(/(\*\*[^*\n]+\*\*)/g)) {
    if (!part) continue;
    const bold = part.match(/^\*\*([^*\n]+)\*\*$/);
    if (bold) {
      out.push({ text: bold[1]!, strong: true });
      continue;
    }
    let last = 0;
    for (const m of part.matchAll(EMPHASIS)) {
      if (m.index! > last) out.push({ text: part.slice(last, m.index) });
      out.push({ text: m[1]!, em: true });
      last = m.index! + m[0].length;
    }
    if (last < part.length) out.push({ text: part.slice(last) });
  }
  return out;
}

/**
 * Submission text → blocks, WITHOUT changing a word.
 *
 * Teams pasted plain prose, Markdown-ish lists (`* item`, `- item`, `•`),
 * `###` headings and `**bold**`. Those become paragraphs, lists, small
 * headings and emphasis; everything is still rendered as escaped TEXT by the
 * template (there is no HTML path), so nothing a team typed can become markup.
 */
export function narrativeBlocks(text: string | null | undefined): Block[] {
  const source = (text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  if (!source) return [];
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length)
      blocks.push({ type: 'p', content: inline(para.join(' ').replace(/\s+/g, ' ').trim()) });
    para = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ type: 'ul', items: list.map((item) => inline(item)) });
    list = [];
  };
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: 'h', content: inline(heading[1]!) });
    } else if (bullet) {
      flushPara();
      list.push(bullet[1]!);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

/** Plain text for meta descriptions: first ~155 characters, on a word boundary. */
export function excerpt(text: string | null | undefined, max = 155): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).replace(/[,;:—–-]+$/, '')}…`;
}

// ── cards ────────────────────────────────────────────────────────────────

/** What a project card renders: its icon, name, one line and its links. Nothing else. */
export interface CardProps {
  /** The href /projects/<slug>/ and the icon. */
  slug: string;
  title: string;
  /** One line: cardText(). */
  text?: string | null;
  links?: { live?: string | null; repo?: string | null; video?: string | null };
  /** md: 64px tile (56 on phones); lg: 88px tile (72 on phones). */
  size?: 'md' | 'lg';
  /** Default 'h3'. */
  level?: 'h2' | 'h3' | 'h4';
}

/**
 * One plain line for a card. The first paragraph block of narrativeBlocks(description), its inlines'
 * text joined (Markdown markers and line breaks gone), cut by excerpt(…, 160); else ownSummary(summary)
 * (null for the generated "Built at … · date" line); else null.
 */
export function cardText(p: {
  description?: string | null;
  summary?: string | null;
}): string | null {
  const first = narrativeBlocks(p.description).find((b) => b.type === 'p');
  const text = first?.type === 'p' ? excerpt(first.content.map((i) => i.text).join(''), 160) : '';
  return text || ownSummary(p.summary) || null;
}

/** Takes the directory DTO (links.live/repo/video) or a record-set Project (url/repoUrl/videoUrl). */
export function cardProps(
  p: {
    slug: string;
    title: string;
    description?: string | null;
    summary?: string | null;
    links?: { live: string | null; repo: string | null; video: string | null };
    url?: string;
    repoUrl?: string;
    videoUrl?: string;
  },
  extra: Pick<CardProps, 'size' | 'level'> = {},
): CardProps {
  return {
    slug: p.slug,
    title: p.title,
    text: cardText(p),
    links: p.links
      ? { live: p.links.live, repo: p.links.repo, video: p.links.video }
      : { live: p.url ?? null, repo: p.repoUrl ?? null, video: p.videoUrl ?? null },
    ...extra,
  };
}
