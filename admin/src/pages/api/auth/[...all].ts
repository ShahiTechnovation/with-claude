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
 * Note what is NOT delegated: `/api/auth/sign-in/magic-link` would happily send
 * an email to any address on earth, because the plugin only checks the
 * allowlist when the link is opened. The admin does not use it. Requests come
 * in through `/api/login`, which checks `users` first and sends nothing to an
 * address that is not on it.
 */
import type { APIRoute } from 'astro';
import { auth } from '@/server/auth';

export const prerender = false;

const handler: APIRoute = ({ request }) => auth().handler(request);

export const GET = handler;
export const POST = handler;
