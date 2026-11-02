/**
 * Every server path the shell depends on, in one place.
 */

/** The agent harness's API, forwarded by the host with the operator capability attached server-side. */
export const HARNESS_API_BASE = "/app/harness";

/**
 * What the app sends as its bearer token to the harness proxy. It is a marker, not a secret:
 * the proxy discards it and attaches the real capability, and an unmarked request is refused
 * without the `x-pikvm-workspace` header the client adds.
 */
export const HARNESS_MANAGED_TOKEN = "desktop-managed";

/** Our API. */
export const API_BASE = "/app/api/v1";

/** oauth2-proxy's endpoints when the host sits behind it. */
export const OAUTH_USERINFO_PATH = "/oauth2/userinfo";
export const OAUTH_SIGN_OUT_PATH = "/oauth2/sign_out";
