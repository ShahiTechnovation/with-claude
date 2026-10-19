/**
 * The hero mist's clock and palette.
 *
 * mistTime() turns the time the hero has been on screen and a scroll position into shader
 * time. The mist eases in over INTRO_MS, keeps a slow drift for as long as it is on screen,
 * and the visitor's scroll moves it further. A still mist (reduced motion) sits at the
 * intro's end pose and ignores the scroll. The island is src/scripts/hero-mist.ts.
 */

/** How long the mist eases in on load. */
export const INTRO_MS = 4800;
/** Shader seconds the ease-in adds on top of the drift. */
const EASE = 2.4;
/**
 * Shader seconds per second of the drift: the shader's own clock. A wisp swings side to side
 * in ~105 s, and its path repeats every ~314 s.
 */
const PACE = 1;
/** Shader seconds per screen of scroll. */
const PER_SCREEN = 10;
/** Plus EASE, the pose the intro ends on: the still frame. */
const T0 = 12;

export function mistTime(elapsedMs: number, screensScrolled: number, still: boolean): number {
  if (still) return T0 + EASE;
  const x = Math.min(1, Math.max(0, elapsedMs / INTRO_MS));
  // The drift runs through the intro too, counted from its end, so the speed never jumps
  // and the intro still ends on the still frame's pose.
  return (
    T0 +
    EASE * (1 - (1 - x) ** 3) +
    ((elapsedMs - INTRO_MS) / 1000) * PACE +
    screensScrolled * PER_SCREEN
  );
}

/** A `--glow`-style token ("217 119 87") as 0–1 channels for a shader uniform. */
export function rgbTriplet(value: string): number[] {
  return value
    .trim()
    .split(/\s+/)
    .map((v) => Number(v) / 255);
}
