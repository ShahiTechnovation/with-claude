/**
 * Submission panels.
 *
 * Composes the filled-in fields into a clean block of text the person sends
 * themselves. Nothing is transmitted from here — there is no endpoint to
 * transmit to, and pretending otherwise would be the one dishonest thing on a
 * site built around not doing that.
 *
 * If a form ever gains a real `data-endpoint`, this posts to it instead and
 * reports the result. The markup does not change.
 */
type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

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

function initPanel(form: HTMLFormElement): void {
  const composeButton = form.querySelector<HTMLButtonElement>('[data-submit-compose]');
  const out = form.querySelector<HTMLElement>('[data-submit-out]');
  const text = form.querySelector<HTMLElement>('[data-submit-text]');
  const copyButton = form.querySelector<HTMLButtonElement>('[data-submit-copy]');
  const copyLabel = form.querySelector<HTMLElement>('[data-submit-copy-label]');
  if (!composeButton || !out || !text) return;

  // The button is `type="button"`, so the form can never navigate. This is
  // belt and braces for the Enter key.
  form.addEventListener('submit', (event) => event.preventDefault());

  composeButton.addEventListener('click', async () => {
    if (!form.reportValidity()) return;

    const body = compose(form);
    text.textContent = body;
    out.hidden = false;

    const endpoint = form.dataset.endpoint;
    if (endpoint) {
      // A real endpoint exists: post it and say what happened.
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
        });
        text.textContent = response.ok
          ? 'Sent. An organiser will review it before it appears.'
          : `${body}\n\n(Sending failed — please paste this into the community channel.)`;
      } catch {
        text.textContent = `${body}\n\n(Sending failed — please paste this into the community channel.)`;
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
