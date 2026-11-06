/**
 * better-auth's own endpoints.
 *
 * This is the one place the library is allowed to handle a request directly:
 * it owns `/api/auth/magic-link/verify` (opening the link), `/api/auth/get-session`
 * and `/api/auth/sign-out`. Its handler does its own Origin checking and rate
 * limiting, which is why `/api/auth` is in the middleware's public list — it
 * has to be reachable without a session, because it is where sessions come
 * from.
 *
 * Note what is NOT delegated: `/api/auth/sign-in/*` would happily send a magic
 * link to any address on earth, because the plugin only checks the allowlist
 * when the link is opened. So it answers 404 here. Requests come in through
 * `/api/login`, which checks `users` first and sends nothing to an address that
 * is not on it; it signs in through `auth().api`, not over HTTP.
 */
import type { APIRoute } from 'astro';
import { auth } from '@/server/auth';

export const prerender = false;

const handler: APIRoute = ({ request }) =>
  new URL(request.url).pathname.startsWith('/api/auth/sign-in/')
    ? new Response('Not found.', { status: 404 })
    : auth().handler(request);

export const GET = handler;
export const POST = handler;
