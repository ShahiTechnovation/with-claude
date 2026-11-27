/**
 * Apple-style liquid glass: the masthead's capsule and the hero's button (batch 019's demo, built
 * in batch 024).
 *
 * Elements marked `data-lens="<filter id>"` get an SVG filter whose displacement map is drawn at the
 * element's own size: a capsule outline, a bezel along the rim with Kube's convex squircle profile
 * (https://kube.io/blog/liquid-glass-css-svg), and Snell's law (glass 1.5) for how far light shifts
 * sideways at each point of the bezel. Every pixel samples the backdrop from further inside, so the
 * rim never reads outside the box. Red, green and blue shift by slightly different amounts, which
 * gives the colour fringe at the edge. `data-lens-scale` is the largest shift in px, times two.
 *
 * Only Chromium runs an SVG filter inside backdrop-filter, so the lens is built only there, and
 * `html.lg-lens` (set here, only there) is what lets the CSS use `url(#id)`; other browsers keep
 * plain frosted glass.
 *
 * Elements marked `data-liquid` also lean and stretch toward a nearby pointer, squash on a press
 * (107% wide, 92% tall) and spring back (the CSS transition carries the spring); the light under the
 * pointer follows it. Unlike the other buttons, whose box never moves on a press, the glass gets
 * shorter: a mouse click or a tap within about 2px of its top or bottom edge can be released outside
 * it, and then the click is lost. Measured in batch 024: 1-2px in, held 60-400ms, lost; 3px in, and
 * the left and right edges, arrive. The user chose the squash anyway. With reduced motion nothing
 * leans, stretches or squashes.
 */
export {}; // a module: its names stay its own, and tests can import it

const SVG_NS = 'http://www.w3.org/2000/svg';
const BEZEL = 0.62; // of the capsule's radius
const IOR = 1.5;

type Brands = { userAgentData?: { brands: { brand: string }[] } };
const chromium = !!(navigator as Navigator & Brands).userAgentData?.brands?.some((b) =>
  /Chromium/.test(b.brand),
);

/** Sideways shift across the bezel, from the rim (index 0) inwards, normalised to 1 at its peak. */
const PROFILE = (() => {
  const n = 128;
  const height = (x: number) => Math.pow(1 - Math.pow(1 - x, 4), 0.25); // convex squircle
  const eta = 1 / IOR;
  const out = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const d = 1e-3;
    const slope = (height(Math.min(x + d, 1)) - height(Math.max(x - d, 0))) / (2 * d);
    // Surface normal in the cross-section, light falling straight down, refracted into the glass.
    const len = Math.hypot(slope, 1);
    const nx = -slope / len;
    const ny = 1 / len;
    const k = 1 - eta * eta * (1 - ny * ny);
    const t = eta * ny - Math.sqrt(k);
    const tx = t * nx;
    const ty = -eta + t * ny;
    out[i] = (tx / -ty) * height(x); // how far it travels sideways before reaching the base
    max = Math.max(max, Math.abs(out[i]));
  }
  for (let i = 0; i < n; i++) out[i] /= max || 1;
  return out;
})();

function drawMap(w: number, h: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(w, h);
  const r = h / 2;
  const bezel = r * BEZEL;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vx = x + 0.5 - Math.min(Math.max(x + 0.5, r), w - r);
      const vy = y + 0.5 - r;
      const len = Math.hypot(vx, vy) || 1e-6;
      const fromRim = r - len;
      const m =
        fromRim >= 0 && fromRim < bezel
          ? PROFILE[Math.min(PROFILE.length - 1, Math.floor((fromRim / bezel) * PROFILE.length))]
          : 0;
      const i = (y * w + x) * 4;
      img.data[i] = 128 - 127 * (vx / len) * m;
      img.data[i + 1] = 128 - 127 * (vy / len) * m;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string>,
  parent: Element,
) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.append(node);
  return node;
}

const SPLIT = [1, 0.913, 0.826]; // red, green, blue
// A press made with any button but the main one (a right-click opens a menu) may never see its
// release, so it is not a press. A context menu (a macOS ctrl-click reports the main button, a
// long touch opens one too), a window blur or a page hidden mid-press is a release.
const RELEASES = ['pointerup', 'pointercancel', 'pointerleave', 'contextmenu'];
const LOST = ['blur', 'pagehide'];

if (chromium) {
  const defs = document.createElementNS(SVG_NS, 'svg');
  defs.setAttribute('width', '0');
  defs.setAttribute('height', '0');
  defs.setAttribute('aria-hidden', 'true');
  defs.style.position = 'absolute';
  document.body.append(defs);

  for (const target of document.querySelectorAll<HTMLElement>('[data-lens]')) {
    const id = target.dataset.lens ?? '';
    const scale = Number(target.dataset.lensScale ?? 40);
    const filter = el(
      'filter',
      { id, x: '0', y: '0', filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' },
      defs,
    );
    const map = el(
      'feImage',
      { x: '0', y: '0', preserveAspectRatio: 'none', result: 'map' },
      filter,
    );
    const shifts = SPLIT.map((f, c) => {
      const d = el(
        'feDisplacementMap',
        {
          in: 'SourceGraphic',
          in2: 'map',
          scale: String(scale * f),
          xChannelSelector: 'R',
          yChannelSelector: 'G',
          result: `d${c}`,
        },
        filter,
      );
      const keep = [
        '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
        '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0',
        '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0',
      ][c];
      el(
        'feColorMatrix',
        { in: `d${c}`, type: 'matrix', values: `${keep} 0 0 0 1 0`, result: `c${c}` },
        filter,
      );
      return d;
    });
    el('feBlend', { in: 'c0', in2: 'c1', mode: 'screen', result: 'c01' }, filter);
    el('feBlend', { in: 'c01', in2: 'c2', mode: 'screen' }, filter);

    const redraw = () => {
      const w = Math.round(target.offsetWidth);
      const h = Math.round(target.offsetHeight);
      if (!w || !h) return;
      for (const node of [filter, map]) {
        node.setAttribute('width', String(w));
        node.setAttribute('height', String(h));
      }
      map.setAttribute('href', drawMap(w, h));
    };
    new ResizeObserver(redraw).observe(target);
    // Pressing thickens the lens a little: more bend at the rim.
    const thicken = (by: number) =>
      shifts.forEach((d, c) => d.setAttribute('scale', String(scale * SPLIT[c] * by)));
    target.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      thicken(1.3);
    });
    for (const type of RELEASES) target.addEventListener(type, () => thicken(1));
    for (const type of LOST) addEventListener(type, () => thicken(1));
  }
}
document.documentElement.classList.toggle('lg-lens', chromium);

// --- The liquid part: lean, stretch, squish, spring ------------------------
const moving = matchMedia('(prefers-reduced-motion: no-preference)');
for (const target of document.querySelectorAll<HTMLElement>('[data-liquid]')) {
  const FIELD = 80; // px around the element where it starts to lean toward the pointer
  let lean = { x: 0, y: 0 };
  let pressed = false;
  let frame = 0;
  let pointer: PointerEvent | null = null;
  const set = (lx: number, ly: number, sx: number, sy: number) => {
    target.style.setProperty('--lx', `${lx.toFixed(2)}px`);
    target.style.setProperty('--ly', `${ly.toFixed(2)}px`);
    target.style.setProperty('--lsx', sx.toFixed(4));
    target.style.setProperty('--lsy', sy.toFixed(4));
  };
  // Back to rest forgets the lean too, so the next press (a tap has no pointer before it) squashes
  // in place instead of jumping to where the last pointer was.
  const rest = () => {
    lean = { x: 0, y: 0 };
    set(0, 0, 1, 1);
  };
  const update = () => {
    frame = 0;
    if (!moving.matches) return rest();
    if (pressed) return set(lean.x, lean.y, 1.07, 0.92);
    const e = pointer;
    if (!e) return rest();
    const box = target.getBoundingClientRect();
    // The box includes the current lean; take it back out so the pull does not chase itself.
    const cx = box.left + box.width / 2 - lean.x;
    const cy = box.top + box.height / 2 - lean.y;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const near = Math.abs(dx) < box.width / 2 + FIELD && Math.abs(dy) < box.height / 2 + FIELD;
    if (!near) return rest();
    lean = { x: Math.max(-12, Math.min(12, dx * 0.12)), y: Math.max(-7, Math.min(7, dy * 0.2)) };
    const over = Math.abs(dx) < box.width / 2 && Math.abs(dy) < box.height / 2;
    const ax = Math.min(Math.abs(dx) / (box.width / 2 + FIELD), 1);
    const ay = Math.min(Math.abs(dy) / (box.height / 2 + FIELD), 1);
    const base = over ? 1.02 : 1;
    // Stretch along the pull, thin across it, so the volume reads as constant.
    set(
      lean.x,
      lean.y,
      base * (1 + ax * 0.05) * (1 - ay * 0.025),
      base * (1 + ay * 0.06) * (1 - ax * 0.03),
    );
    target.style.setProperty('--mx', `${e.clientX - box.left}px`);
    target.style.setProperty('--my', `${e.clientY - box.top}px`);
  };
  const queue = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  addEventListener(
    'pointermove',
    (e) => {
      pointer = e;
      queue();
    },
    { passive: true },
  );
  document.documentElement.addEventListener('pointerleave', () => {
    pointer = null;
    queue();
  });
  target.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    pressed = true;
    target.classList.add('is-pressed');
    queue();
  });
  const release = () => {
    if (!pressed) return;
    pressed = false;
    target.classList.remove('is-pressed');
    queue();
  };
  for (const type of RELEASES) target.addEventListener(type, release);
  for (const type of LOST) addEventListener(type, release);
}
