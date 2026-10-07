/**
 * THE MASTHEAD: its links, its scripts and the account mount point.
 *
 * Split out of `homepage-routing.test.ts`, then moved to the dark shell's `<details>`
 * menu and theme toggle.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// LF regardless of how the checkout was made (core.autocrlf on Windows).
const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
// Every script-bearing file under src, so a second binder anywhere is caught.
const srcFiles = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.(astro|ts|tsx)$/.test(file))
  .map((file) => `src/${file.replace(/\\/g, '/')}`)
  .sort();

describe('the masthead', () => {
  const masthead = source('src/components/Masthead.astro');

  it('links the logo home and Projects to the directory', () => {
    // `/` everywhere except projects.withclaude.in, where `/` is the directory.
    expect(masthead).toContain('const home = homeHref(Astro.url.hostname);');
    expect(masthead).toMatch(/<a href=\{home\} class="brand"/);
    expect(masthead).toContain("{ href: '/projects/', label: 'Projects' }");
  });

  /**
   * Two scripts once bound the same menu button, so each tap opened the drawer
   * and shut it again. The phone menu is now a native `<details>`: it opens with
   * JS off and nothing binds a toggle button.
   */
  it('builds the phone menu as a <details> that no script binds', () => {
    expect(masthead).toMatch(/<details class="menu">\s*<summary/);
    const binders = srcFiles.filter((file) => source(file).includes('[data-nav-toggle]'));
    expect(binders).toEqual([]);
  });

  /** Two writers of the stored theme would race; the toggle is the only one. */
  it('lets only the masthead bind the theme toggle and write wc-theme', () => {
    expect(
      srcFiles.filter((file) =>
        /querySelector[^(]*\(\s*['"]\[data-theme-toggle\]['"]/.test(source(file)),
      ),
    ).toEqual(['src/components/Masthead.astro']);
    expect(
      srcFiles.filter((file) => /localStorage\.setItem\(\s*['"]wc-theme['"]/.test(source(file))),
    ).toEqual(['src/components/Masthead.astro']);
    // Hidden without JS: nothing could switch it.
    expect(masthead).toMatch(/<button[^>]*class="[^"]*\bjs-only\b[^"]*"[^>]*data-theme-toggle/);
  });

  /**
   * PrivyRoot portals into `#account-slot-root` by id and account-boot mounts
   * `#privy-root` by id, so a second AccountNav would duplicate both ids.
   */
  it('renders exactly one AccountNav', () => {
    expect(masthead.match(/<AccountNav\b/g)).toHaveLength(1);
  });

  /** account-boot opens Privy from any `[data-account-signin]`; without JS the link still goes to sign-in. */
  it('gives the phone sheet a plain Sign in link that account-boot picks up', () => {
    expect(masthead).toMatch(
      /<a class="btn menu-signin" href=\{signInHref\(Astro\.url\.hostname\)\} data-account-signin\s*>Sign in<\/a\s*>/,
    );
  });

  /**
   * Under 900px the bar's account slot is hidden while signed out. Once Privy has booted,
   * account-boot no longer catches the sheet's link, so the masthead hands the tap to
   * PrivyRoot's live button (only its inner `.account-slot` matches) instead of following
   * the no-JS href, and resets the "Opening sign-in…" label once PrivyRoot renders.
   */
  it('hands the sheet Sign in to the live Privy button once Privy is running', () => {
    const script = masthead.slice(masthead.indexOf('<script>'));
    expect(script).toContain("signin?.addEventListener('click'");
    expect(script).toContain('if (e.defaultPrevented) return;');
    expect(script).toContain("slotRoot?.querySelector<HTMLElement>('.account-slot .account-join')");
    expect(script).toMatch(/e\.preventDefault\(\);[\s\S]*live\.click\(\);/);
    expect(script).toMatch(/new MutationObserver[\s\S]*signin\.removeAttribute\('aria-busy'\)/);
  });

  /** The open sheet locks the page behind it, for scrolling and for assistive tech. */
  it('makes the page behind the open menu inert and unscrollable', () => {
    expect(masthead).toMatch(/menu\.addEventListener\('toggle'[\s\S]*el\.inert = menu\.open;/);
    // Not <html>: that turns body (overflow-x: hidden) into the sticky bar's scroller.
    expect(masthead).toContain("document.body.style.overflow = menu.open ? 'hidden' : '';");
    expect(masthead).not.toContain('root.style.overflow');
  });

  /** With JS off nothing sets `inert`, so CSS hides the covered page from Tab. */
  it('hides the page under the open sheet without JS', () => {
    expect(masthead).toMatch(
      /:global\(body:has\(\.masthead \.menu\[open\]\) > :is\(\.skip-link, main, footer\)\) \{\s*visibility: hidden;/,
    );
  });

  /** A back/forward-cache restore or another tab skips the head script. */
  it('reads the saved theme again on a cache restore and on a change in another tab', () => {
    expect(masthead).toContain(
      "addEventListener('pageshow', (e) => e.persisted && rereadTheme());",
    );
    expect(masthead).toContain(
      "addEventListener('storage', (e) => e.key === 'wc-theme' && rereadTheme());",
    );
    expect(masthead).toMatch(
      /function rereadTheme\(\) \{\s*if \(root\.hasAttribute\('data-theme-lock'\)\) return;/,
    );
  });

  /** Tab past the sheet's last item lands on <body> (the page is inert): that closes it too. */
  it('closes the menu when Tab leaves it, but not on a click on the sheet', () => {
    expect(masthead).toContain("document.addEventListener('pointerdown', () => (tabbed = false));");
    expect(masthead).toContain("tabbed = e.key === 'Tab';");
    expect(masthead).toContain('(tabbed || now !== document.body) && !menu.contains(now)');
  });

  /** The root's scroll-padding covers the sticky bar: a focused control in it must not scroll the page. */
  it('keeps focus in the bar from scrolling the page', () => {
    expect(masthead).toMatch(
      /\.masthead-inner :global\(:is\(a, button, summary\):not\(\.menu-sheet \*\)\) \{\s*scroll-margin-top: calc\(-1 \* \(var\(--nav-h\) \+ 1rem\)\);/,
    );
  });

  /** Colour alone does not mark the current page (WCAG 1.4.1). */
  it('underlines the current page in the phone sheet', () => {
    expect(masthead).toMatch(
      /\.menu-sheet a\[aria-current\] \{[^}]*text-decoration: underline 1px var\(--clay\);/,
    );
  });

  /** `active` is a slash-less prefix ('/events') and the nav hrefs end in '/', so a bare startsWith marked nothing. */
  it('marks the current section against the slashed nav hrefs', () => {
    const body = /const current = \(href: string\) => (.+);/.exec(masthead)?.[1] ?? 'false';
    const current = new Function('active', 'href', `return ${body};`) as (
      active: string,
      href: string,
    ) => boolean;
    expect(current('/events', '/events/')).toBe(true);
    expect(current('/discover', '/discover/')).toBe(true);
    expect(current('/', '/events/')).toBe(false);
    expect(current('/eventsx', '/events/')).toBe(false);
    expect(masthead.match(/aria-current=\{current\(/g)).toHaveLength(4);
  });

  /**
   * `#privy-root` sits inside the masthead's flex row. As a block it took a
   * flex gap of its own and pushed the account control ~20px off the column
   * edge on every page; the island it replaced was `display: contents`.
   */
  it('keeps the Privy mount point out of the masthead layout', () => {
    expect(source('src/components/AccountNav.astro')).toMatch(
      /#privy-root\s*\{\s*display:\s*contents;/,
    );
  });
});
