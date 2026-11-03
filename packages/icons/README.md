# @pikvm/icons

Phosphor icons with rounder, continuous ("squircle") corners. The geometry comes from `@phosphor-icons/core`
(MIT, see `LICENSE`). `scripts/build.ts` changes it and writes one React component per icon.

## Use

```tsx
import { SidebarSimple, House } from "@pikvm/icons";

<SidebarSimple weight="fill" size={20} />
<House aria-label="Home" />
```

The names are the same as `@phosphor-icons/react`: `House`, `HouseIcon` and the old aliases. Props:

| Prop                                   | Default          | Notes                                                                      |
| -------------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `size`                                 | `"1em"`          | width and height                                                           |
| `weight`                               | `"regular"`      | `regular`, `fill` or `bold`. Other Phosphor weights fall back to `regular` |
| `color`                                | `"currentColor"` |                                                                            |
| `mirrored`                             | `false`          | flips the icon horizontally                                                |
| `alt`, `aria-label`, `aria-labelledby` |                  | any of these gives `role="img"`; without them the icon is `aria-hidden`    |

The ref goes to the `<svg>`. Other SVG props pass through.

## Generation safety

The generator must account for these failure cases:

- A source asset cannot be read or parsed.
- A custom export name conflicts with a Phosphor export or alias.
- Generation stops before all modules are ready.
- A developer server reads modules while generation runs.
- A file is only partly written when another process reads it.
- A repeated build changes output without an input change.
- Smoothing reverses a contour, removes a hole, narrows a stroke or adds an intersection.
- A custom closed stroke has the wrong contour direction.
- A failed build replaces the previous usable output.

Generate every output file in a staging directory first. Replace each complete file with an atomic rename.
Keep the current generated modules available throughout the build. This is not a whole-directory transaction:
a developer server can briefly read modules from both builds, but their module contracts stay the same.

Use `yarn workspace @pikvm/icons build --output /tmp/pikvm-icons-check` to generate a separate copy without changing the live
modules. Use a new directory for each verification run. Compare two copies to check deterministic output.

## Commands

- `yarn workspace @pikvm/icons build`: generate `src/generated/`, `src/index.ts` and `preview.html`
- `yarn workspace @pikvm/icons typecheck`: type-check

Do not edit `src/generated/` or `src/index.ts` by hand. The output is deterministic, so a rebuild with no input
change gives no diff.

`preview.html` is git-ignored (about 3 MB). Open it in a browser after a build. It shows the source next to the
rounded output, an overlay with the source outline in red, and a 24 px copy. Use `?q=name` to filter and
`?size=96` to change the cell size.

## How the rounding works

Phosphor draws strokes as expanded outlines. A rectangle frame is an outer contour with radius 16 arcs and an
inner contour (hole) with sharp corners. The build:

1. parses every path into lines, cubics and circular arcs
2. finds corners: two lines that meet at an angle, or two lines joined by a short fillet arc or cubic
3. adds a fixed amount to each corner radius (`r_new = r_old + delta`). Outer and inner corners get the same
   amount, so the stroke keeps its width round the corner
4. replaces each corner with a continuous corner: cubic, circular arc, cubic. `smoothing` sets how much of the
   turn the cubics carry. The handles give curvature continuity (G2), as in Figma corner smoothing
5. writes the result at 1/10 unit precision and checks it against the source

## Parameters

These are `DEFAULT_OPTIONS` in `scripts/smooth.ts`.

| Name                        | Value       | Why                                                                                                                                          |
| --------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `delta`                     | 24          | Radius added to each corner. Corner pairing reduces it where the inner contour cannot support the same change, so the stroke keeps its width |
| `smoothing`                 | 0.8         | The brief's value. 80% of the turn is in the transition curves, so corners read as continuous, not as arcs on lines                          |
| `clamp`                     | 0.45        | A corner may use at most 45% of each neighbouring segment, so two corners on one short edge never overlap                                    |
| `junctionDelta`             | 0           | Radius added where two strokes join or cross. Rounding there grows webbing (X, Plus, magnifier handle)                                       |
| `acuteTangent`              | 1.4         | Sharp tips (carets, lightning, arrow heads) get less radius, scaled by `min(1, 1.4 / tan(theta/2))`. Without it, a fill caret becomes a "D"  |
| `minTurn` / `maxTurn`       | 5 / 170 deg | Smaller turns are not corners; larger ones are stroke caps, which are already round                                                          |
| `maxFilletTangent`          | 28          | A fillet between two lines with a tangent length up to this counts as a corner and is rebuilt                                                |
| `microRun`                  | 2.5         | Fillets shorter than this count as sharp corners                                                                                             |
| `curveHandle`               | 0.62        | Handle scale where a corner meets a curve, not a line                                                                                        |
| `partnerMin` / `partnerMax` | 2 / 40      | Distance range for the parallel-edge test that finds crossings                                                                               |
| `probeStep`                 | 8           | Start offset of the rays that find joins on hole corners                                                                                     |

When a corner is too big for its edges, the radius shrinks first, down to the source radius. After that the
smoothing goes down, then the radius goes below the source radius. Figma reduces smoothing first, but that turns
small squares (SquaresFour, Command) into circles.

## Gates: corners kept as drawn

- Crossing gate (concave corners): there is a parallel edge on the inside, 2 to 40 units away, which overlaps by
  more than 1 unit and is not joined to this corner. That is a stroke crossing (X, Plus, arrow shafts).
- Join gate (convex corners of holes): three rays go into the material, two across the bars and one along the
  bisector. If they come out through different subpaths, the hole corner is a T-join or a crossing in a grid
  (Table, Globe, CircleHalf hatch). If it was rounded, the cells would turn into blobs.
- Concave corners next to a curve are joins (magnifier handle, speech bubble tail).

## Checks

Each smoothed path is parsed again and compared with the source. A geometry problem stops the build before
output files change. Source-path exceptions appear in the preview under "flagged":

- winding: each subpath keeps the sign of its area, so holes stay holes
- shrink below 0.7 or grow above 1.15 of the source area
- more self-intersections than the source
- a different subpath count
- reversed lines (two corners overran one edge)
- stroke width loss above 15%, or empty-gap loss above 50%, measured between separate contours

## Overrides

`scripts/overrides.ts` can change options for one icon (`"kebab-name"` or `"kebab-name:weight"`), or ship the source path
(`"source"`). Each exception records the geometry problem. Source exceptions apply only to weights that fail
the stroke-width checks.

## Custom icons

`ChatCompose` and `ChatComposeIcon` are package drawings for the New chat action. The regular and bold weights
use an open frame and a solid stylus. The fill weight uses a solid tile with a gap around the stylus. These
paths come from `scripts/custom/chat-compose.ts`, not from a reference product.

The registry in `scripts/custom/index.ts` adds custom icons to the same smoothing and geometry checks. The
preview also includes an outlined pencil, a bubble and a wider-opening candidate. Candidates do not add package
exports. Closed stroke contours use clockwise outer paths and counter-clockwise holes.

## Output size

Path data grows by about 84% (1.76 MB to 3.23 MB over 1513 icons and three weights), because each rounded
corner is three curves. Each icon is its own module with `"sideEffects": false`, so a bundle only has the icons it
imports.
