#!/usr/bin/env node
/**
 * LOCAL TEST AUTHENTICATION — for browser journeys against an isolated
 * development database. Never for a deployment.
 *
 *   node scripts/dev/test-auth.mjs keys           create .dev-auth/{private,public}.pem
 *   node scripts/dev/test-auth.mjs token <did>    print an access token for <did>
 *
 * The server's real verification path is unchanged: `verifyRequest()` calls
 * `@privy-io/node`'s `verifyAccessToken()` with a static key, exactly as it
 * does in production when `PRIVY_VERIFICATION_KEY` is set. What is different
 * is only WHICH key: run the dev server with
 *
 *   PRIVY_APP_ID=wc-local-test
 *   PRIVY_VERIFICATION_KEY="$(cat .dev-auth/public.pem)"
 *
 * and tokens minted here verify; real Privy tokens do not. This proves the
 * server-side journeys (guards, bootstrap, profile, projects, moderation)
 * end to end. It does NOT prove production OAuth: Privy's own login, its
 * cookie on the real domain, and the dashboard's allowed origins can only be
 * checked against the real app.
 *
 * Refuses to run when any deployment marker is present.
 */
import { generateKeyPair, exportPKCS8, exportSPKI, importPKCS8, SignJWT } from 'jose';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.VERCEL || process.env.VERCEL_ENV || process.env.NODE_ENV === 'production') {
  console.error('test-auth refuses to run in a deployment environment.');
  process.exit(1);
}

const DIR = join(process.cwd(), '.dev-auth');
const APP_ID = process.env.PRIVY_APP_ID || 'wc-local-test';
const [command, did] = process.argv.slice(2);

if (command === 'keys') {
  mkdirSync(DIR, { recursive: true });
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  writeFileSync(join(DIR, 'private.pem'), await exportPKCS8(privateKey), { mode: 0o600 });
  writeFileSync(join(DIR, 'public.pem'), await exportSPKI(publicKey));
  console.log(`Wrote ${DIR}/private.pem and public.pem (app id: ${APP_ID}).`);
} else if (command === 'token' && did) {
  if (!existsSync(join(DIR, 'private.pem'))) {
    console.error('No key pair. Run: node scripts/dev/test-auth.mjs keys');
    process.exit(1);
  }
  const key = await importPKCS8(readFileSync(join(DIR, 'private.pem'), 'utf8'), 'ES256');
  const ttl = Number(process.env.TOKEN_TTL_SECONDS ?? 3600);
  const token = await new SignJWT({ sid: `local-session-${Date.now()}` })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setIssuer('privy.io')
    .setAudience(APP_ID)
    .setSubject(did)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(key);
  process.stdout.write(token);
} else {
  console.error('Usage: test-auth.mjs keys | token <did:privy:…>');
  process.exit(1);
}
