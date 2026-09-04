/**
 * The magic-link email.
 *
 * One transactional message: here is your link, it expires, somebody asked for
 * it from this address. Nothing else is ever sent from the admin.
 *
 * ── IT FAILS LOUDLY ──────────────────────────────────────────────────────
 *
 * Unlike the public site's acknowledgement — which is a courtesy, and where
 * losing the email is better than losing the submission — a magic link IS the
 * sign-in. An email that silently fails to send is an account nobody can get
 * into, presented as a screen that says "check your inbox". So this throws,
 * and the login route says the mail could not be sent.
 *
 * In development with no Resend credentials it does not fake a send either: it
 * prints the link to the server console and says so, which is honest, works
 * offline, and cannot be mistaken for a delivered message.
 */
import { Resend } from 'resend';

export interface MagicLinkMessage {
  to: string;
  url: string;
  expiresInMinutes: number;
}

export type MagicLinkOutcome =
  { delivered: true; id?: string } | { delivered: false; printedToConsole: true; reason: string };

function body({ url, expiresInMinutes }: MagicLinkMessage): { subject: string; text: string } {
  return {
    subject: 'WITH CLAUDE — your sign-in link',
    text: [
      'Somebody asked to sign in to the WITH CLAUDE admin with this address.',
      '',
      'Open this link to sign in:',
      url,
      '',
      `It works once and expires in ${expiresInMinutes} minutes.`,
      '',
      'If that was not you, nothing has happened and you can ignore this. The',
      'link cannot be used without opening it, and nobody has been signed in.',
      '',
      '—',
      'WITH CLAUDE — admin.withclaude.in',
    ].join('\n'),
  };
}

export async function sendMagicLinkEmail(message: MagicLinkMessage): Promise<MagicLinkOutcome> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const { subject, text } = body(message);

  if (!apiKey || !from) {
    const missing = [!apiKey && 'RESEND_API_KEY', !from && 'RESEND_FROM']
      .filter(Boolean)
      .join(' and ');

    if (process.env.NODE_ENV === 'production' && process.env.VERCEL_ENV !== 'preview') {
      // A deployed admin that cannot send a sign-in link is locked, not
      // degraded. Refuse rather than leave somebody staring at "check your
      // inbox" for a message that was never going to arrive.
      throw new Error(`${missing} is not set. The admin cannot send sign-in links.`);
    }

    console.warn(
      `\n[auth] ${missing} not set — no email sent.\n` +
        `[auth] Development sign-in link for ${message.to}:\n\n    ${message.url}\n`,
    );
    return { delivered: false, printedToConsole: true, reason: `${missing} not set` };
  }

  const result = await new Resend(apiKey).emails.send({
    from,
    to: message.to,
    subject,
    text,
    ...(process.env.RESEND_REPLY_TO ? { replyTo: process.env.RESEND_REPLY_TO } : {}),
  });

  if (result.error) {
    console.error('[auth] Resend rejected the sign-in link:', result.error);
    throw new Error(result.error.message);
  }

  return { delivered: true, id: result.data?.id };
}
