/**
 * The acknowledgement email.
 *
 * It says one thing: we have it, a person will read it, and nothing is
 * published yet. That last clause is the whole point — the site's entire
 * promise is that a submission is reviewed before it appears, and an email
 * that implied otherwise would break the promise at the first contact.
 *
 * WHAT THIS IS NOT: a newsletter, a digest, or a publication notification.
 * There is no list to be on. This is one transactional message in reply to
 * something the person just did.
 *
 * ── WHEN RESEND IS NOT CONFIGURED ──────────────────────────────────────
 *
 * In development there are usually no credentials. This does NOT pretend to
 * have sent anything: it returns `skipped` with the reason, the endpoint
 * reports that in its response, and the submission is still stored. Faking a
 * successful send would mean the first real deployment is the first time
 * anybody finds out the email layer never worked.
 *
 * In production, missing credentials are a misconfiguration rather than a
 * local convenience, so they are logged as an error — but they still do not
 * fail the request, because a submission that reached the database is
 * captured, and throwing away a person's work over an email is the wrong
 * trade.
 */
import { Resend } from 'resend';
import { isProduction, resendConfig } from '../../../db/env';

export type AcknowledgementResult =
  | { delivered: true; id?: string }
  | { delivered: false; skipped: true; reason: string }
  | { delivered: false; skipped: false; reason: string };

/** What each form's acknowledgement calls the thing that was sent. */
const SUBJECT_BY_KIND: Record<string, string> = {
  builder: 'your builder index entry',
  project: 'your project submission',
  'use-case': 'your Claude write-up',
  'city-interest': 'your city signal',
};

interface Acknowledgement {
  to: string;
  kind: string;
  name?: string;
  /** e.g. `WITH CLAUDE`. */
  wordmark: string;
  /** Where a person can reply or follow up. */
  channelLabel: string;
  channelUrl: string;
}

function body({ kind, name, wordmark, channelLabel, channelUrl }: Acknowledgement): {
  subject: string;
  text: string;
} {
  const thing = SUBJECT_BY_KIND[kind] ?? 'your submission';
  const greeting = name ? `Hi ${name},` : 'Hi,';

  return {
    subject: `${wordmark} — we have ${thing}`,
    text: [
      greeting,
      '',
      `Thank you — ${thing} reached us and is safely on the record.`,
      '',
      'It is now waiting for a person to read it. Everything submitted to this site is',
      'reviewed by a human before it is published, so please do not assume it is live:',
      'nothing appears on the site until somebody has actually looked at it, and not',
      'everything that is submitted is published.',
      '',
      'We will not email you again about this unless there is something to say.',
      '',
      `If you need to add or correct anything, reply here or find us on ${channelLabel}:`,
      channelUrl,
      '',
      '—',
      `${wordmark} is an independent, volunteer-run community of people building with`,
      'Claude in India. It is not an Anthropic property and does not speak for them.',
    ].join('\n'),
  };
}

/**
 * Send one acknowledgement.
 *
 * Never throws. The caller has already stored the submission by the time this
 * runs, and the outcome is reported rather than raised so a mail outage cannot
 * turn a captured submission into a 500.
 */
export async function sendAcknowledgement(
  message: Acknowledgement,
): Promise<AcknowledgementResult> {
  const { apiKey, from, replyTo } = resendConfig();

  if (!apiKey || !from) {
    const missing = [!apiKey && 'RESEND_API_KEY', !from && 'RESEND_FROM']
      .filter(Boolean)
      .join(' and ');
    const reason = `${missing} not set — no acknowledgement was sent.`;

    if (isProduction()) {
      // A deployed site that cannot acknowledge a submission is broken, even
      // though the submission itself was captured. Say so loudly in the logs.
      console.error(`[acknowledge] ${reason} See .env.example.`);
    } else {
      console.warn(`[acknowledge] ${reason} This is expected in development.`);
    }
    return { delivered: false, skipped: true, reason };
  }

  const { subject, text } = body(message);

  try {
    const result = await new Resend(apiKey).emails.send({
      from,
      to: message.to,
      subject,
      text,
      ...(replyTo ? { replyTo } : {}),
    });

    if (result.error) {
      console.error('[acknowledge] Resend rejected the message:', result.error);
      return { delivered: false, skipped: false, reason: result.error.message };
    }
    return { delivered: true, id: result.data?.id };
  } catch (error) {
    console.error('[acknowledge] Could not reach Resend:', error);
    return {
      delivered: false,
      skipped: false,
      reason: error instanceof Error ? error.message : 'Unknown mail error.',
    };
  }
}
