/**
 * Session-switch safety. When the user starts a new chat (or resumes another), the
 * client may still have a debounced persist of the PREVIOUS transcript in flight. If
 * that save lands after the server has switched sessions, it bleeds the old conversation
 * into the new one ("press +, paste a prompt, and it shows the previous chat"). The
 * client tags each persist with the session it belongs to; the server drops any save
 * whose tag no longer matches the current session. Pure + tested so the rule can't rot.
 */

/** True if a transcript save tagged for `taggedSessionId` should be REJECTED because the
 *  server has since moved to `currentSessionId`. An untagged save (legacy client) is
 *  always accepted. */
export function isStaleUiSave(taggedSessionId: unknown, currentSessionId: string): boolean {
    return typeof taggedSessionId === "string" && taggedSessionId !== currentSessionId;
}
