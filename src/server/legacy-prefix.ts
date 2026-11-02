/**
 * The old `/_agent/` prefix, kept only so installed apps can leave it.
 *
 * Before the move to `/app/`, the PWA was installed with start_url `/_agent/`
 * and a service worker registered at `/_agent/sw.js` (scope `/_agent/`,
 * network-first). Those installs still exist on phones. After the cutover
 * `/_agent/*` would fall through to kvmd, so the installed app would open the
 * Pi's own UI or a 404, and its old worker would keep serving stale shells.
 *
 * Two things, and nothing else, answer under the old prefix:
 *   - `/_agent/sw.js` is a RETIRE worker. The browser re-fetches the worker
 *     script on launch, finds this one, installs it, and it deletes the old
 *     caches, unregisters itself and sends its windows to `/app/`.
 *   - every other GET or HEAD under `/_agent` redirects to `/app/`. No path
 *     mapping: the old console and its sub-paths are all `/app/` now.
 *
 * REMOVAL: delete this file, its two routes in routes.ts, `/_agent/sw.js` in
 * auth.ts PUBLIC_PATHS and the tests that name `/_agent`, once every installed
 * copy has launched at least once (a few weeks for a one-user deployment).
 */

/** The cache names the old service worker used (src/views/sw.js, then and now). */
const OLD_CACHES = ["pikvm-console-v2", "pikvm-agent-v1"];

export const RETIRE_WORKER = `// Retires the service worker that used to live under /_agent/.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            for (const name of ${JSON.stringify(OLD_CACHES)}) await caches.delete(name);
            await self.registration.unregister();
            const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            for (const client of windows) {
                try {
                    await client.navigate(self.location.origin + "/app/");
                } catch (e) {
                    /* a client that cannot be navigated is simply left */
                }
            }
        })(),
    );
});
`;
