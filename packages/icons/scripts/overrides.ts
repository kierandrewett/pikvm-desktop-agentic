/**
 * Per-icon exceptions to the global smoothing options.
 *
 * Key: Phosphor kebab name ("house"), or name plus weight ("house:fill") for one weight only.
 * Value: option overrides merged over DEFAULT_OPTIONS, or "source" to ship Phosphor's path unchanged.
 * Every entry needs a comment that says what went wrong without it. Override only the weight that fails, so the
 * other weights keep the global look.
 */
import type { SmoothOptions } from "./smooth.ts";

export type Override = Partial<SmoothOptions> | "source";

const DEG = Math.PI / 180;

export const OVERRIDES: Readonly<Record<string, Override>> = {
    // Curve-adjacent corners have no parallel partner. Every tested positive delta narrows these strokes beyond
    // the 15% check limit, including delta 8. Keep only the failing weights as source until pairing supports them.
    "airplane-in-flight:regular": "source",
    "airplane-taxiing:regular": "source",
    "armchair:bold": "source",
    "dress:bold": "source",
    "hamburger:regular": "source",
    "hamburger:bold": "source",
    "jar-label:regular": "source",
    "jar-label:fill": "source",
    "jar-label:bold": "source",
    "pipe-wrench:regular": "source",
    "pipe-wrench:fill": "source",
    // Wide teeth with a short flat top. At the global curveTurn (10 degrees) both tip fillets run far into the
    // top arc and each tooth turns into a round petal, so the gear reads as a flower. 5 degrees keeps a flat top.
    "gear-six": { curveTurn: 5 * DEG },
    // Solid gear: with no inner contour to show the tooth outline, the softer tips read as petals at 32 px and
    // up. Regular and bold keep the global value.
    "gear:fill": { curveTurn: 5 * DEG },
    // The acute left point: the hole's tip is a join and stays sharp, so the outer point may only take the pairing
    // slack, and at delta 24 the stroke still thins from 8 to 5 units at the tip (check: thin). 12 passes.
    "backspace:regular": { delta: 12 },
    // The flap's diagonals meet the frame at the corners. The cut-outs there are acute joins with no parallel
    // partner, so the frame corner rounds alone and the frame thins from 16 to 12.3 units (check: thin). 20 passes.
    "envelope:regular": { delta: 20 },
    "envelope:fill": { delta: 20 },
    // Same as envelope: the diagonal runs into two frame corners and the frame thins to 12.8 units. 20 passes.
    "placeholder:regular": { delta: 20 },
    // Holes in a diamond: the diamond's sides and the holes' corners are not parallel at the tips, so the tips
    // thin from 19.4 to 14 units (check: thin). 16 passes.
    "google-podcasts-logo:fill": { delta: 16 },
    // The slash's cut-out runs into the frame corner as an acute join; the frame thins from 16 to 9.3 units
    // (check: thin). 12 passes.
    "selection-slash:fill": { delta: 12 },
    // The bill's corners are line, radius-8 fillet, wave cubic. Rebuilding that fillet against the kept sharp
    // corner of the hole thins the stroke from 16 to 12 units at any delta (check: thin), so keep the fillets.
    "money-wavy:regular": { maxCurveFillet: 0 },
    // Same shape of problem: the rind's top corners are line, radius-8 fillet, big arc, and the ring's hole corner
    // next to them stays sharp. The rebuilt fillet thins the rind from 16 to 13.1 units (check: thin).
    "orange-slice:regular": { maxCurveFillet: 0 },
};
