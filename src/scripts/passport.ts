/**
 * The Builder Passport form, submitted as JSON.
 *
 * ── WHY THIS IS NOT A PLAIN FORM POST ────────────────────────────────────
 *
 * It nearly is. The markup is a real `<form>` with real fields and real
 * labels, and everything in it works without this file loaded — the browser
 * would post it and the endpoint would answer. What this adds is the JSON
 * encoding the member API expects and inline error messages instead of a
 * navigation to a JSON document.
 *
 * The API takes JSON rather than form encoding on purpose: `.strict()` schema
 * parsing gives an unknown field an ERROR rather than a silently dropped
 * value, and a form body cannot express `null` (for clearing a city) or a
 * boolean distinctly from the string "false".
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
 *
 * It does not decide anything. It does not know who the member is, does not
 * hold a token, and does not send an id — the cookie goes with the request and
 * the server derives everything from it. This file could be replaced by curl
 * and the security properties would be identical.
 */

/**
 * Trailing slash deliberate. A 308 preserves the method and body, but this is
 * a write path and it must not depend on that redirect never being downgraded
 * to a 301, which would drop the body silently — see `src/data/forms.ts`.
 */
const PROFILE_ENDPOINT = '/api/member/profile/';

interface FieldError {
  error?: string;
  field?: string;
}

function setStatus(form: HTMLFormElement, message: string, tone: 'ok' | 'error' | 'busy'): void {
  const status = form.querySelector<HTMLElement>('[data-passport-status]');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function clearFieldErrors(form: HTMLFormElement): void {
  form.querySelectorAll<HTMLElement>('[data-field-error]').forEach((el) => {
    el.textContent = '';
  });
}

function showFieldError(form: HTMLFormElement, field: string | undefined, message: string): void {
  if (!field) return;
  const target = form.querySelector<HTMLElement>(`[data-field-error="${field}"]`);
  if (target) target.textContent = message;
}

/**
 * Read the form into the shape the API accepts.
 *
 * Only fields with a `name` are read, empty strings are omitted rather than
 * sent as `""` (a PATCH should not blank a field the person did not touch),
 * and the two non-string types are converted explicitly.
 */
function payloadOf(form: HTMLFormElement): Record<string, unknown> {
  const data = new FormData(form);
  const payload: Record<string, unknown> = {};

  for (const [key, raw] of data.entries()) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();

    if (key === 'publicEmail') {
      payload[key] = true; // an unchecked box is simply absent
      continue;
    }
    if (key === 'citySlug') {
      // The one field that can be deliberately cleared.
      payload[key] = value === '' ? null : value;
      continue;
    }
    if (value === '') continue;
    payload[key] = value;
  }

  // An unchecked checkbox sends nothing, so absence has to be made explicit.
  if (form.querySelector<HTMLInputElement>('[name="publicEmail"]') && !('publicEmail' in payload)) {
    payload.publicEmail = false;
  }

  return payload;
}

async function save(form: HTMLFormElement, publish: boolean): Promise<void> {
  clearFieldErrors(form);
  setStatus(form, 'Saving…', 'busy');

  const response = await fetch(PROFILE_ENDPOINT, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payloadOf(form)),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as FieldError;
    setStatus(form, body.error ?? 'That could not be saved.', 'error');
    showFieldError(form, body.field, body.error ?? '');
    return;
  }

  if (!publish) {
    setStatus(form, 'Saved.', 'ok');
    return;
  }

  setStatus(form, 'Publishing…', 'busy');

  const published = await fetch(PROFILE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  });

  const body = (await published.json().catch(() => ({}))) as FieldError & {
    message?: string;
    url?: string;
  };

  if (!published.ok) {
    setStatus(form, body.error ?? 'That could not be published.', 'error');
    return;
  }

  // Said plainly: the row is committed, the page is still building.
  setStatus(form, body.message ?? 'Published.', 'ok');
}

export function passport(): void {
  const form = document.querySelector<HTMLFormElement>('[data-passport]');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    void save(form, submitter?.value === 'publish');
  });
}
