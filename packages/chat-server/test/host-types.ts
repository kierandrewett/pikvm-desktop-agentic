/** Compile-time only: the real server satisfies the declaration the host type-checks against (../host.d.ts). */
import type * as Declared from "../host.d.ts";
import * as Real from "../src/index.ts";

export const satisfies: typeof Declared = Real;
