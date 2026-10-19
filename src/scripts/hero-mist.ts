/**
 * The hero mist.
 *
 * Clay smoke drifting over the hero's CSS sun: a WebGL port of polkadot.com's hero shader
 * (noise plus two drifting wisps), without three.js. Value noise rather than polkadot's raw
 * hash, so it stays smooth and the site's film grain stays the only grain. The colour is
 * premultiplied clay that fades out above the copy.
 *
 * The clock is src/lib/mist.ts: an eased intro on load, then a slow drift while the hero is
 * on screen, plus the scroll; reduced motion gets one still frame. Progressive by
 * construction: without WebGL, or with a driver that cannot build the shader, the canvas
 * stays empty and the CSS sun is the hero.
 */
import { mistTime, rgbTriplet } from '@/lib/mist';

const FRAG = `
  // highp where the GPU has it: at mediump (16-bit on Mali and Adreno) the sin-hash loses its
  // fraction, the noise falls to zero and only two flat blobs are left.
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif
  uniform vec2 u_res;
  uniform float u_time;
  uniform vec3 u_glow;
  uniform vec3 u_hot;
  uniform float u_strength;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
    return v;
  }

  // A soft blob wandering around a point low in the frame, where the sun sits.
  float wisp(vec2 st, float t, vec2 o, float aspect) {
    vec2 c = vec2(aspect * (0.5 + sin(t * 0.3 + o.x) * 0.3), 0.22 + cos(t * 0.2 + o.y) * 0.12);
    return 1.0 - smoothstep(0.0, 0.55, distance(st, c));
  }

  void main() {
    float aspect = u_res.x / u_res.y;
    vec2 st = gl_FragCoord.xy / u_res.y;
    float t = u_time * 0.2;
    vec2 warped = st + vec2(sin(st.y * 3.0 + t) * 0.05, cos(st.x * 2.0 + t * 0.7) * 0.03);
    float n1 = fbm(warped * 3.0 + t * 0.1);
    float n2 = fbm(warped * 7.0 - t * 0.05);
    float w = wisp(st, t, vec2(0.0), aspect) + 0.8 * wisp(st, t, vec2(3.14159, 1.57), aspect);
    float smoke = smoothstep(0.35, 0.85, n1 + w * 0.6) * (0.55 + 0.45 * n2);
    float fade = 1.0 - smoothstep(0.05, 0.75, st.y);
    float a = clamp(u_strength * smoke * w * fade, 0.0, 1.0);
    vec3 col = mix(u_glow, u_hot, smoothstep(0.5, 0.9, n1 * n2 + w * 0.1));
    gl_FragColor = vec4(col * a, a);
  }`;
const VERT = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
/** The mist is soft: draw at half size and let the browser upscale. */
const SCALE = 0.5;

function initMist(canvas: HTMLCanvasElement, gl: WebGLRenderingContext): void {
  const program = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VERT],
    [gl.FRAGMENT_SHADER, FRAG],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.bindAttribLocation(program, 0, 'p');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const uTime = uniform('u_time');

  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  let still = !motion.matches;
  let elapsed = 0;

  // Past the first screen counts as out of sight: the hero is scrolled off, or under the room
  // photo on the scroll stage. On a screen shorter than the hero (560px under the nav) its foot
  // still shows there, holding its last frame. A still mist draws wherever the page is.
  const away = () => !still && scrollY >= innerHeight;
  const draw = () => {
    if (gl.isContextLost() || away()) return;
    gl.uniform1f(uTime, mistTime(elapsed, scrollY / innerHeight, still));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  // The palette and strength are tokens, so they follow the theme toggle.
  const paint = () => {
    const css = getComputedStyle(canvas);
    gl.uniform3fv(uniform('u_glow'), rgbTriplet(css.getPropertyValue('--glow')));
    gl.uniform3fv(uniform('u_hot'), rgbTriplet(css.getPropertyValue('--hot')));
    gl.uniform1f(uniform('u_strength'), Number(css.getPropertyValue('--mist')));
    draw();
  };
  // Resizing clears the canvas, so draw again in the same task.
  const resize = () => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * SCALE));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * SCALE));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniform('u_res'), canvas.width, canvas.height);
    draw();
  };

  resize();
  paint();
  canvas.classList.add('is-on');
  new ResizeObserver(resize).observe(canvas);
  new MutationObserver(paint).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  // One frame loop while the hero is on screen and motion is allowed: it stops once the hero
  // is scrolled away, and a scroll or resize that brings it back restarts it. A hidden tab
  // gets no frames, so the loop sleeps there too. A lost context stops it for good: nothing
  // restores one, and the CSS sun is left.
  // The clock adds each frame's time, capped at 100 ms, so after a pause the mist resumes
  // where it was instead of jumping.
  let running = false;
  let last = 0;
  const frame = (now: number) => {
    elapsed += Math.min(100, Math.max(0, now - last));
    last = now;
    running = !still && !away() && !gl.isContextLost();
    if (!running) return;
    draw();
    requestAnimationFrame(frame);
  };
  const run = () => {
    if (running || still || away()) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  };
  addEventListener('scroll', run, { passive: true });
  addEventListener('resize', run);
  // The setting can change mid-visit: reduce draws the still frame and the loop stops at its
  // next frame; allowing motion again resumes the drift where it left off.
  motion.addEventListener('change', () => {
    still = !motion.matches;
    draw();
    run();
  });
  run();
}

// After load and idle, context included: the h1 keeps the first frames and the LCP.
const canvas = document.querySelector<HTMLCanvasElement>('.hero .mist');
if (canvas) {
  const start = () => {
    const gl = canvas.getContext('webgl', {
      antialias: false,
      depth: false,
      powerPreference: 'low-power',
    });
    if (gl) initMist(canvas, gl);
  };
  const later = () =>
    'requestIdleCallback' in window
      ? requestIdleCallback(start, { timeout: 2000 })
      : setTimeout(start, 200);
  if (document.readyState === 'complete') later();
  else addEventListener('load', later, { once: true });
}
