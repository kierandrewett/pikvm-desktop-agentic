/** Reload the app. A seam so tests can watch it: jsdom cannot reload. */
export function reloadApp(): void {
    window.location.reload();
}
