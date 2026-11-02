/**
 * Every server path the shell depends on, in one place. The two embedded surfaces are
 * temporary: phase 3 replaces the workspace frame with the chat module and phase 4 the
 * console frame with the KVM screen, and those are the only two constants that go away.
 */

/** The existing console, served by the host until the KVM screen is ported. */
export const LEGACY_CONSOLE_PATH: string = import.meta.env.VITE_LEGACY_CONSOLE_PATH ?? "/app/legacy/";

/** The existing agent workspace, served by the host until chat is ported. */
export const WORKSPACE_PATH: string = import.meta.env.VITE_WORKSPACE_PATH ?? "/app/workspace/";

/** Our API. */
export const API_BASE = "/app/api/v1";

/** oauth2-proxy's endpoints when the host sits behind it. */
export const OAUTH_USERINFO_PATH = "/oauth2/userinfo";
export const OAUTH_SIGN_OUT_PATH = "/oauth2/sign_out";
