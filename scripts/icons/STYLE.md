# WITH CLAUDE project icons

One small square tile per project, in the Claude Community event-kit look: a terracotta tile with one
chunky object drawn in thick near-black ink and filled with paper white. It should sit next to the owner's
reference (the bridge) and the kit plates (`src/assets/plates/*.jpg`) as one family.

Calibrated on: `nyaya` (scales of justice), `fly-invaders` (fruit fly), `synapse-os` (chat bubble with a
medical cross), `strata` (stepped tank of the Great Bath, with water). See them in
`src/assets/project-icons/` before drawing a new one.

## Template

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
<rect width="96" height="96" rx="8" fill="#D97757"/>
<g stroke="#141413" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">
<path fill="none" d="..."/>      <!-- lines: legs, strings, cables, waves -->
<path fill="#FAF9F5" d="..."/>   <!-- the body -->
<path fill="#141413" d="..."/>   <!-- optional small solid detail -->
</g>
</svg>
```

Save as `src/assets/project-icons/<slug>.svg`. Every shape goes inside that one `<g>` so the ink settings are set once.

## Hard rules (lint.mjs checks these)

- `viewBox="0 0 96 96"`, `xmlns` on the root.
- First shape is the tile, exactly `<rect width="96" height="96" rx="8" fill="#D97757"/>`, full-bleed, no stroke.
- Palette, nothing else: tile `#D97757`, ink `#141413`, paper `#FAF9F5`. Fills may be `#FAF9F5`, `#141413`,
  `#D97757` (a hole that shows the tile) or `none`. Strokes are `#141413` only.
- One stroke width: `4`, with `stroke-linejoin="round"` and `stroke-linecap="round"`. Every edge is inked;
  a paper or tile fill with no outline fails.
- At most 4 shapes on the tile. Put several parts in one `<path>` (multiple subpaths) when they share a fill.
- Elements allowed: `svg g path rect circle ellipse line polyline polygon`. No `<text>`, `<title>`, `<image>`,
  `<style>`, gradients, filters, masks, `style=`, `opacity`, `class`, `id`.
- `transform` may only `translate` or `rotate` (scaling would change the line weight).
- No fill left unset (SVG would paint it pure black, which is off-palette).
- File under 4 KB (keep coordinates to one decimal place; lint does not check that part).

## Drawing rules (check by eye)

- **Weight.** The reference ink is 6.0px on a 104px-wide object (5.8%), so 4 units on a ~64-unit object.
  White strips that sit between two ink edges should be about as wide as the ink, so draw bars and posts
  about 8 units wide (4 white + 4 ink), as in the bridge's posts and deck.
- **Safe area.** All ink, strokes included, stays inside 16..80 on both axes. The object's longest side
  should be 52 to 64 units, and its ink box is centred on 48,48 within 3 units.
- **One concrete object.** Draw the thing the project handles or makes (a fly, a bubble, a tank of
  water), not an abstract idea. No letters, numbers, logos, faces with expressions, arrows or UI chrome.
  Avoid the generic AI set (robot, brain, sparkle, gear, chip, laptop, lightbulb, chart) unless the
  project is literally about that object.
- **Two ways to fill it, pick one per icon:**
  1. _White body_ (the reference): the object is paper with ink outlines. Use this by default.
  2. _Line drawing with one white accent_ (the kit plates, e.g. the white block in Build Day): the object
     is ink lines on the tile and exactly one part is paper. Use it when a white body would hide the idea.
     `strata` does this: the stepped tank is lines, the water is the one white part.
- **Solid ink** (`fill="#141413"`) is only for small details up to about 18 units across: an eye, a head,
  a dot, a node. Never for the main body.
- **Order** back to front: lines (fill none), then bodies, then small solid details. Overlapping subpaths
  in one paper path show all their outlines, which reads as see-through (the fly's wings over its body).
- **Spacing.** Keep at least 4 units of colour (tile or paper) between two parallel ink lines, and do not
  let small black details touch other ink, or they merge into a blob at 48px (the first fly heads did).
- **Slightly hand-drawn.** Bow long straight edges by 0.5 to 1 unit with a curve, nudge a few points off the
  grid by 0.2 to 0.5, and let mirrored halves differ a little. Soften rectangle corners (radius 1.5 to 2)
  or let the round joins do it. Keep it chunky and calm, not scribbly.
- **Legibility.** The icon must still say what it is at 48px, and keep a clear silhouette at 24px. If it
  only works at 160px, remove detail.

## Workflow

```sh
node scripts/icons/lint.mjs src/assets/project-icons/<slug>.svg   # PASS, or a list of problems; exit 1 on failure
```

Look at the icon at 160px, 48px and 24px next to the four calibration icons and ask: same weight? same
family? readable at 48px? Redraw until all three are yes. `node scripts/icons/lint.mjs --self-test` checks
the linter itself, and `tests/project-card.test.ts` fails for any project in `src/data/projects.ts` without
an icon.

Note: the reference screenshot's tile measures #CC7C5E because of the screen capture; the tile colour is #D97757.
