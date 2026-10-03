/**
 * The Vercel function refuses the adapter's path override (GHSA-mr6q-rp88-fx84).
 *
 * `@astrojs/vercel` before 10.0.2 lets any caller choose which route renders,
 * through the `x-astro-path` header or the `x_astro_path` query parameter, and
 * swaps the path before middleware runs. The middleware guard saw only the
 * header, and only on routes it reached: the query parameter, and a header
 * aimed at a path that falls through to the prerendered 404, went past it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapter = vi.hoisted(() => ({ handler: vi.fn(), createExports: vi.fn() }));
vi.mock('@astrojs/vercel/serverless/entrypoint', () => ({
  createExports: adapter.createExports,
  start: () => {},
}));

import { createExports } from '../src/server/vercel-entrypoint';

function request(url: string, headers: Record<string, string> = {}) {
  return { url, headers } as unknown as IncomingMessage;
}

function response() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headers,
    ended: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end() {
      res.ended = true;
    },
  };
  return res;
}

async function serve(req: IncomingMessage) {
  const { default: handler } = createExports({} as never, {} as never);
  const res = response();
  await handler(req, res as unknown as ServerResponse);
  return res;
}

describe('the Vercel function entry', () => {
  beforeEach(() => {
    adapter.handler.mockReset();
    adapter.createExports.mockReset();
    adapter.createExports.mockReturnValue({ default: adapter.handler });
  });

  it("wraps the adapter's own entry with the same manifest and options", () => {
    const manifest = { routes: [] };
    const options = { middlewareSecret: 'x', skewProtection: false };
    createExports(manifest as never, options as never);
    expect(adapter.createExports).toHaveBeenCalledWith(manifest, options);
  });

  it('refuses the x-astro-path header before the adapter reads it', async () => {
    const res = await serve(request('/', { 'x-astro-path': '/not-found/' }));
    expect(res.statusCode).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.ended).toBe(true);
    expect(adapter.handler).not.toHaveBeenCalled();
  });

  it.each([
    '/?x_astro_path=/api/me/',
    '/events/?city=bhopal&x_astro_path=%2Fapi%2Fme%2F',
    '/?x%5Fastro%5Fpath=/api/me/',
    '/?x_astro_path',
  ])('refuses the x_astro_path query parameter: %s', async (url) => {
    const res = await serve(request(url));
    expect(res.statusCode).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(adapter.handler).not.toHaveBeenCalled();
  });

  it('hands every other request to the adapter untouched', async () => {
    const req = request('/events/?city=bhopal', { 'x-forwarded-for': '203.0.113.7' });
    const res = await serve(req);
    expect(adapter.handler).toHaveBeenCalledOnce();
    expect(adapter.handler.mock.calls[0]![0]).toBe(req);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(false);
  });
});

describe('the built function', () => {
  // Fail rather than skip, like the other build checks: CI builds first.
  it('is built from this entry, not the adapter’s unguarded one', () => {
    const server = 'dist/server';
    expect(existsSync(server), 'run `astro build` first').toBe(true);
    const files = readdirSync(server, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.mjs'))
      .map((file) => readFileSync(join(server, file), 'utf8'));
    expect(files.some((code) => code.includes('refusePathOverride'))).toBe(true);
  });
});
