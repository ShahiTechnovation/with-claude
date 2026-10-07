/**
 * The event-kit tile drawn for each project (scripts/icons/STYLE.md), as inline markup: no request,
 * and the same result in vitest and in the build. The files are ours and lint-checked (no ids,
 * scripts, images, styles or hrefs), so set:html is safe.
 *
 * ponytail: a new project shows the blank clay tile until someone draws its icon with STYLE.md;
 * tests/project-card.test.ts fails for any project in src/data/projects.ts that has none.
 */
const files = import.meta.glob<string>('/src/assets/project-icons/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const bySlug = new Map(
  Object.entries(files).map(([path, svg]) => [path.slice(path.lastIndexOf('/') + 1, -4), svg]),
);

export const projectIcon = (slug: string): string | undefined => bySlug.get(slug);
