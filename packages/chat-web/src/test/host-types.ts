/** Compile-time only: the real package satisfies the declaration the host app type-checks against (../../host.d.ts). */
import type * as Declared from "../../host.d.ts";
import * as Real from "../index";

export const satisfies: typeof Declared = Real;

import type * as DeclaredSettings from "../../settings.d.ts";
import * as RealSettings from "../settings";

export const settingsSatisfies: typeof DeclaredSettings = RealSettings;
