import { describe, expect, it } from 'vitest';
import { projects } from '../src/data/projects';
import { resolveProjectCover } from '../src/lib/project-cover';

describe('resolveProjectCover', () => {
  it('shows a member upload from Vercel Blob', () => {
    const url = 'https://abc123.public.blob.vercel-storage.com/projects/1/cover.jpg';
    expect(resolveProjectCover(url)).toEqual({ kind: 'blob', blobUrl: url });
  });

  it('refuses any other absolute URL, such as a stock-photo service', () => {
    expect(resolveProjectCover('https://picsum.photos/seed/clonex/800/600')).toEqual({
      kind: 'none',
    });
    expect(resolveProjectCover('http://abc.public.blob.vercel-storage.com/x.jpg')).toEqual({
      kind: 'none',
    });
  });

  it('keeps every project image in the record to a repo asset or a Blob upload', () => {
    const outside = projects.filter(
      (p) =>
        p.image && /^https?:\/\//i.test(p.image) && resolveProjectCover(p.image).kind !== 'blob',
    );
    expect(outside.map((p) => p.slug)).toEqual([]);
  });
});
