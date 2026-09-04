/**
 * Submission panels.
 *
 * A form with an endpoint posts to it and reports what happened. A form
 * without one composes what you typed into a clean block of text you send
 * yourself. Both paths end at the same place — an organiser reading it — and
 * the composed text is produced either way, because it is also the fallback.
 *
 * THE FALLBACK IS THE POINT OF THIS FILE.
 *
 * If the POST fails for any reason — the endpoint is down, the network is
 * gone, the server said no — what the person typed is still on screen, still
 * complete, and still one click from the clipboard. A form that loses somebody's
 * answers because a server was having a bad afternoon is worse than a form
 * with no server, so failure falls back rather than apologising.
 *
 * Two small things are sent alongside the fields, and neither is content:
 * a honeypot that must stay empty, and how long the form was on screen. Both
 * are read and discarded by the server. Nothing here is a substitute for
 * server-side validation, which is the authority.
 */
type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Must match `CONTROL_FIELDS` in `src/server/submissions/validate.ts`. */
const HONEYPOT_FIELD = 'website';
const ELAPSED_FIELD = 'elapsed_ms';

function compose(form: HTMLFormElement): string {
  const subject = form.dataset.subject ?? 'SUBMISSION';
  const controls = Array.from(form.querySelectorAll<Control>('[data-label]'));

  const lines = controls
    .filter((control) => control.value.trim().length > 0)
    .map((control) => `${control.dataset.label}: ${control.value.trim()}`);

  return [subject, '—'.repeat(Math.min(subject.length, 40)), ...lines].join('\n');
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The fields the server expects, plus the two control values.
 *
 * Only controls carrying `data-label` are read, so the honeypot — which does
 * not have one — is added explicitly rather than swept up by a `FormData`
 * pass that would also collect anything else in the markup.
 */
function payload(form: HTMLFormElement, openedAt: number): Record<string, string | number> {
  const fields: Record<string, string | number> = {};

  for (const control of Array.from(form.querySelectorAll<Control>('[data-label]'))) {
    if (!control.name) continue;
    const value = control.value.trim();
    if (value.length > 0) fields[control.name] = value;
  }

  fields.form = form.dataset.formId ?? '';
  fields[HONEYPOT_FIELD] =
    form.querySelector<HTMLInputElement>(`[name="${HONEYPOT_FIELD}"]`)?.value ?? '';
  fields[ELAPSED_FIELD] = Date.now() - openedAt;

  return fields;
}

/** What to show when the post did not go through. The work is never lost. */
function fallbackText(composed: string): string {
  return `${composed}\n\n(Sending failed — please paste this into the community channel.)`;
}

function initPanel(form: HTMLFormElement): void {
  const composeButton = form.querySelector<HTMLButtonElement>('[data-submit-compose]');
  const out = form.querySelector<HTMLElement>('[data-submit-out]');
  const text = form.querySelector<HTMLElement>('[data-submit-text]');
  const head = form.querySelector<HTMLElement>('[data-submit-out-head]');
  const note = form.querySelector<HTMLElement>('[data-submit-out-note]');
  const copyButton = form.querySelector<HTMLButtonElement>('[data-submit-copy]');
  const copyLabel = form.querySelector<HTMLElement>('[data-submit-copy-label]');
  if (!composeButton || !out || !text) return;

  // When the panel was first rendered. The server uses the elapsed time to
  // reject submissions that arrive faster than a person can type one.
  const openedAt = Date.now();

  const defaultHead = head?.textContent ?? '';
  const defaultNote = note?.textContent ?? '';

  // The button is `type="button"`, so the form can never navigate. This is
  // belt and braces for the Enter key.
  form.addEventListener('submit', (event) => event.preventDefault());

  composeButton.addEventListener('click', async () => {
    if (!form.reportValidity()) return;

    const composed = compose(form);
    text.textContent = composed;
    if (head) head.textContent = defaultHead;
    if (note) note.textContent = defaultNote;
    out.hidden = false;

    const endpoint = form.dataset.endpoint;

    if (endpoint) {
      composeButton.disabled = true;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload(form, openedAt)),
        });

        if (response.ok) {
          const result = (await response.json().catch(() => ({}))) as {
            message?: string;
            acknowledgementSent?: boolean;
          };

          if (head) head.textContent = 'Sent';
          text.textContent =
            result.message ?? 'Received. A person will read it before anything is published.';
          if (note) {
            // Never claim an email is coming when the server said it did not
            // send one.
            note.textContent =
              result.acknowledgementSent === false
                ? 'Nothing is published yet — an organiser reviews every submission first.'
                : 'A confirmation is on its way to your email. Nothing is published yet — an organiser reviews every submission first.';
          }
        } else {
          // Includes validation failures: the person keeps their text and a
          // route to a human either way.
          const problem = (await response.json().catch(() => ({}))) as { error?: string };
          if (head) head.textContent = 'Could not send';
          text.textContent = fallbackText(composed);
          if (note && problem.error) note.textContent = problem.error;
        }
      } catch {
        if (head) head.textContent = 'Could not send';
        text.textContent = fallbackText(composed);
      } finally {
        composeButton.disabled = false;
      }
    }

    out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    copyButton?.focus();
  });

  copyButton?.addEventListener('click', async () => {
    const done = await copy(text.textContent ?? '');
    if (!copyLabel) return;
    copyLabel.textContent = done ? 'Copied' : 'Select and copy';
    window.setTimeout(() => {
      copyLabel.textContent = 'Copy';
    }, 2400);
  });
}

document.querySelectorAll<HTMLFormElement>('[data-submit-form]').forEach(initPanel);
