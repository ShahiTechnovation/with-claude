/**
 * SHOW ONLY THE LOGIN METHODS THE PRIVY APP HAS SWITCHED ON.
 *
 * `PUBLIC_PRIVY_LOGIN_METHODS` lists what we would like to offer. Privy draws a
 * button for every one of them, even one that is off in its dashboard, and a
 * click on it then fails with 403 `disallowed_login_method`. So, before the
 * popup mounts, read the app's public config (the same request the SDK makes)
 * and drop the methods whose flag is false. A method is only ever removed,
 * never added; an unknown name is kept; a failed request or an empty result
 * leaves the configured list as it is.
 */

/**
 * Privy login method name → its flags in `GET /api/v1/apps/<appId>`. The SDK
 * treats a method as on when any of its flags is true, so it is only off when
 * every one is false.
 */
const FLAGS: Record<string, string[]> = {
  email: ['email_auth'],
  sms: ['sms_auth'],
  google: ['google_oauth'],
  github: ['github_oauth'],
  apple: ['apple_oauth'],
  discord: ['discord_oauth'],
  twitter: ['twitter_oauth'],
  linkedin: ['linkedin_oauth'],
  tiktok: ['tiktok_oauth'],
  spotify: ['spotify_oauth'],
  instagram: ['instagram_oauth'],
  line: ['line_oauth'],
  twitch: ['twitch_oauth'],
  telegram: ['telegram_auth', 'telegram_oauth'],
  passkey: ['passkey_auth'],
  wallet: ['wallet_auth', 'solana_wallet_auth'],
  farcaster: ['farcaster_auth'],
};

export function filterLoginMethods(configured: string[], appConfig: unknown): string[] {
  if (!appConfig || typeof appConfig !== 'object') return configured;
  const flags = appConfig as Record<string, unknown>;
  const kept = configured.filter((method) => {
    const names = FLAGS[method];
    return !names || !names.every((name) => flags[name] === false);
  });
  return kept.length > 0 ? kept : configured;
}

/**
 * The configured methods the app has enabled. No cache of our own: Privy sends
 * the config (and its CORS preflight) with max-age=300, so the browser keeps it
 * and a dashboard change shows within five minutes. The 10 s abort is only a
 * backstop: account-boot stops waiting shortly after the SDK has loaded.
 */
export async function enabledLoginMethods(appId: string, configured: string[]): Promise<string[]> {
  if (!appId || configured.length === 0) return configured;
  try {
    const res = await fetch(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}`, {
      headers: { 'privy-app-id': appId },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return configured;
    return filterLoginMethods(configured, await res.json());
  } catch {
    return configured;
  }
}
