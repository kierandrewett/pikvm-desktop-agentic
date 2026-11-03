/**
 * Chat turns animation off after a keyboard shortcut until the next pointer action. That mode works through window
 * listeners and a flag on <html>, both of which would reach the host app, so the Chat pane does not have it:
 * motion always follows `--motion-scale`.
 */
export function isInstant(): boolean {
    return false;
}
