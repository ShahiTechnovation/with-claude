/**
 * WHEN THE SIGN-IN CODE FAILS TO DOWNLOAD.
 *
 * account-boot loads PrivyRoot on demand. If that import rejects (a stale tab
 * after a deploy, a dropped connection, a blocker), PrivyRoot never mounts, so
 * its own slow state never shows: Sign in stayed on "Opening sign-in…" and the
 * /me/ gate on "Preparing secure sign-in…". Now the link gets its label back,
 * the next click downloads again, and the gate shows PrivyRoot's slow-start
 * sentence with Reload.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ fail: true, downloads: 0, render: vi.fn(), createRoot: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: sdk.createRoot }));

function PrivyRoot() {
  return null;
}

/** Just enough of an element for account-boot: attributes, text, `[a][b]` selectors. */
class Stub {
  innerHTML = '';
  listeners = new Map<string, () => void>();
  private attributes: Map<string, string>;
  constructor(
    attributes: Record<string, string> = {},
    public textContent = '',
    public dataset: Record<string, string> = {},
  ) {
    this.attributes = new Map(Object.entries(attributes));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  matches(selector: string) {
    return [...selector.matchAll(/\[([\w-]+)\]/g)].every(([, name]) => this.attributes.has(name));
  }
  closest(selector: string) {
    return this.matches(selector) ? this : null;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
}

/** A page with the masthead's Sign in and, on an account page, the sign-in gate. */
function page({ gate = false } = {}) {
  const mount = new Stub({}, '', { appId: 'app1', loginMethods: '' });
  const link = new Stub({ 'data-account-signin': '' }, 'Sign in');
  const reload = new Stub();
  const cta = Object.assign(new Stub(), {
    innerHTML: '<p class="signin-status js-only js-hydrate-hide">Preparing secure sign-in…</p>',
    // The gate's markup is written as HTML; its one button is all the test needs.
    querySelector: (selector: string) =>
      selector === 'button' && cta.innerHTML.includes('<button') ? reload : null,
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const byId: Record<string, Stub> = {
    'privy-root': mount,
    ...(gate ? { 'join-cta-root': cta } : {}),
  };
  vi.stubGlobal('document', {
    cookie: '',
    getElementById: (id: string) => byId[id] ?? null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => [link].filter((el) => el.matches(selector)),
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
  });
  vi.stubGlobal('window', { location: { reload: vi.fn() } });
  vi.stubGlobal('localStorage', { length: 0, key: () => null });
  const click = () => {
    const event = { target: link, preventDefault: vi.fn() };
    listeners.get('click')!(event);
    return event;
  };
  return { mount, link, cta, reload, listeners, click };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  Object.assign(sdk, { fail: true, downloads: 0 });
  sdk.render.mockReset();
  sdk.createRoot.mockReset().mockReturnValue({ render: sdk.render });
  vi.doMock('@/components/react/PrivyRoot', () => {
    sdk.downloads += 1;
    if (sdk.fail) throw new TypeError('Failed to fetch dynamically imported module');
    return { default: PrivyRoot };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a sign-in download that fails', () => {
  it('gives Sign in its label back, and the next click downloads it again', async () => {
    const { mount, link, click } = page();
    await import('../src/scripts/account-boot');

    expect(click().preventDefault).toHaveBeenCalled();
    expect(link.textContent).toBe('Opening sign-in…');
    expect(link.getAttribute('aria-busy')).toBe('true');

    await vi.waitFor(() => expect(link.textContent).toBe('Sign in'));
    expect(link.getAttribute('aria-busy')).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      '[account] sign-in failed to load',
      expect.any(Error),
    );

    // Not the cached failure, and not the static link: a fresh download that opens the login.
    sdk.fail = false;
    expect(click().preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(sdk.render).toHaveBeenCalledTimes(1));
    expect(sdk.downloads).toBe(2);
    expect(sdk.createRoot).toHaveBeenCalledWith(mount);
    expect(sdk.render.mock.calls[0][0]).toMatchObject({
      type: PrivyRoot,
      props: { appId: 'app1', openLogin: true },
    });
  });

  it('is not kept when it started from pointing at Sign in', async () => {
    const { link, listeners, click } = page();
    await import('../src/scripts/account-boot');

    listeners.get('pointerover')!({ target: link });
    await vi.waitFor(() => expect(sdk.downloads).toBe(1));
    await settle();

    click();
    await vi.waitFor(() => expect(link.textContent).toBe('Sign in'));
    expect(sdk.downloads).toBe(2);
  });

  it('shows the gate the slow-start sentence and Reload', async () => {
    const { cta, reload } = page({ gate: true });
    await import('../src/scripts/account-boot');

    await vi.waitFor(() => expect(cta.innerHTML).not.toContain('Preparing'));
    expect(cta.innerHTML).toBe(
      '<div class="signin-failed" role="alert">' +
        '<p class="signin-status">Sign-in is taking longer than usual to load.</p>' +
        '<button type="button" class="signin-button">Reload</button></div>',
    );
    // The same words as PrivyRoot's own slow state, so the two cannot drift apart.
    expect(readFileSync('src/components/react/PrivyRoot.tsx', 'utf8')).toContain(
      '<p className="signin-status">Sign-in is taking longer than usual to load.</p>',
    );
    reload.listeners.get('click')!();
    expect(window.location.reload).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '[account] sign-in failed to load',
      expect.any(Error),
    );
  });
});
