/**
 * THE VERCEL FUNCTION'S ENTRY: the adapter's own, behind one guard.
 *
 * `astro.config.mjs` aliases `@astrojs/vercel/entrypoint` to this file, which
 * imports the real entry under its other exported name. `@astrojs/vercel`
 * before 10.0.2 lets any caller choose which route renders, with the
 * `x-astro-path` header or the `x_astro_path` query parameter
 * (GHSA-mr6q-rp88-fx84). It swaps the path before middleware runs, keeps the
 * method and body, and the CDN files the answer under the URL that was asked
 * for.
 *
 * Only Vercel's ISR and edge middleware set either value, and this site uses
 * neither, so a request that carries one is forged and is refused here, before
 * the adapter reads it. Remove this file and its alias with the move to
 * @astrojs/vercel 10.0.2+ (Astro 6). Turning on ISR or edge middleware before
 * then would trip this guard.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createExports as adapterExports, start } from '@astrojs/vercel/serverless/entrypoint';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createExports(...args: Parameters<typeof adapterExports>) {
  const { default: handler } = adapterExports(...args);
  return { default: refusePathOverride(handler) };
}

export { start };

function refusePathOverride(handler: Handler): Handler {
  return async (req, res) => {
    // Parsed exactly as the adapter parses it, so both read the same request.
    const url = new URL(`https://example.com${req.url}`);
    if (req.headers['x-astro-path'] !== undefined || url.searchParams.has('x_astro_path')) {
      res.statusCode = 400;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }
    return handler(req, res);
  };
}
