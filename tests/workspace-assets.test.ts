import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import test from "node:test";
import { resolve } from "node:path";
import {
    createWorkspaceAssets,
    WORKSPACE_API_BASE,
    WORKSPACE_PREFIX,
} from "../src/workspace-assets";

/* Pointed at the real build output. The default resolves from __dirname, which
 * is dist/ at runtime but a temp directory under the test runner — which is the
 * reason the directory is injectable at all. */
const workspaceAssets = createWorkspaceAssets(
    resolve(process.cwd(), "agent", "pikvm_agent", "harness_ui"),
);

const listen = async () => {
    const server = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0]!;
        if (workspaceAssets.handles(path) && workspaceAssets.serve(path, res)) return;
        res.writeHead(404);
        res.end("nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert(address && typeof address === "object");
    return {
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
};

const fetchRaw = (origin: string, path: string) =>
    new Promise<{ status: number; location?: string; type?: string; body: string }>((resolve, reject) => {
        httpGet(`${origin}${path}`, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
                resolve({
                    status: res.statusCode ?? 0,
                    location: res.headers.location,
                    type: String(res.headers["content-type"] ?? ""),
                    body: Buffer.concat(chunks).toString("utf8"),
                }),
            );
        }).on("error", reject);
    });

test("the workspace mount redirects to its trailing slash", async () => {
    // Assets are referenced relatively, so a document at /_agent/workspace would
    // resolve "./app.js" against the PARENT and load nothing.
    const s = await listen();
    try {
        const r = await fetchRaw(s.origin, WORKSPACE_PREFIX);
        assert.equal(r.status, 302);
        assert.equal(r.location, WORKSPACE_PREFIX + "/");
    } finally {
        await s.close();
    }
});

test("the document tells the bundle where its API is, without an inline script", async () => {
    const s = await listen();
    try {
        const doc = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/");
        assert.equal(doc.status, 200);
        assert.match(doc.type, /text\/html/);
        // A file, not an inline tag: the document ships script-src 'self' with no
        // unsafe-inline, so an inline tag would be blocked and the app would fall
        // back to same-origin /api/*, which here is the kvmd proxy.
        assert.match(doc.body, /<script src="\.\/host-config\.js"><\/script>/);
        assert.doesNotMatch(doc.body, /<script>[^<]*__PIKVM_HARNESS_API_BASE__/);
        // And it must come before the module that reads it.
        assert.ok(doc.body.indexOf("host-config.js") < doc.body.indexOf('<script type="module"'));

        const cfg = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/host-config.js");
        assert.equal(cfg.status, 200);
        assert.match(cfg.type, /javascript/);
        assert.match(
            cfg.body,
            new RegExp(
                `window\\.__PIKVM_HARNESS_API_BASE__ = ${JSON.stringify(WORKSPACE_API_BASE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`,
            ),
        );
        /* And the managed-auth sentinel. sessionStorage is per BROWSING CONTEXT,
         * so seeding the native view did nothing for a frame in the console —
         * it came up asking for a token nobody has. Not a secret: the proxy
         * attaches the real credential and discards whatever a page sends. */
        assert.match(cfg.body, /sessionStorage\.setItem\("pikvm-harness-token", "desktop-managed"\)/);
        /* And the placement bridge. As a native view the workspace got this from
         * a preload; a frame cannot have one, and the app reads window.pikvmPanel
         * while it mounts — so installing it from the console on the frame's load
         * event is already too late and the header silently drops the controls.
         * It has to be here, before the app module. */
        assert.match(cfg.body, /window\.pikvmPanel = \{/);
        for (const method of ["setSide", "toggleDetached", "onPlacement", "onTheme"]) {
            assert.match(cfg.body, new RegExp(`${method}: function`), `bridge is missing ${method}`);
        }
        // It only ever talks to its own parent, at its own origin.
        assert.match(cfg.body, /window\.parent\.postMessage\(/);
        assert.match(cfg.body, /window\.location\.origin/);
        assert.match(cfg.body, /if \(e\.source !== window\.parent\) return;/);
    } finally {
        await s.close();
    }
});

test("built assets are served and escapes are refused", async () => {
    const s = await listen();
    try {
        const app = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/app.js");
        assert.equal(app.status, 200);
        assert.match(app.type, /javascript/);
        assert.ok(app.body.length > 1000);

        // Nothing outside the build directory is reachable, however it is spelled.
        for (const escape of [
            "/../../package.json",
            "/../../../etc/passwd",
            "/..%2f..%2fpackage.json",
        ]) {
            const r = await fetchRaw(s.origin, WORKSPACE_PREFIX + escape);
            assert.notEqual(r.status, 200, `served something for ${escape}`);
        }
    } finally {
        await s.close();
    }
});

test("the shared component bundle is served alongside the workspace", async () => {
    /* The console and the conversation were two design systems in one window:
     * the same 30x30 round icon button existed twice, one with a rendered
     * tooltip and one with the operating system's — which appears after a second
     * and cannot be styled. This entry is how the console gets the real one. */
    const s = await listen();
    try {
        const shared = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/shared.js");
        assert.equal(shared.status, 200);
        assert.match(shared.type, /javascript/);
        assert.match(shared.body, /pikvmShared/);
        // The stylesheet the console needs with it. Measured to change nothing
        // there: Tailwind v4 emits inside @layer and unlayered author CSS beats
        // every layer, so console.css keeps winning where it has an opinion.
        const css = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/styles.css");
        assert.equal(css.status, 200);
        assert.match(css.type, /text\/css/);
    } finally {
        await s.close();
    }
});

test("the shared bundle offers labelled buttons as well as icon ones", async () => {
    /* The titlebar needed icon buttons; the dialogs need labelled ones — Done,
     * Cancel, Delete macro. Same contract on purpose: an update function rather
     * than a remount, because a dialog repaints on every edit and tearing the
     * tree down each time would drop focus mid-interaction. */
    const s = await listen();
    try {
        const shared = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/shared.js");
        assert.equal(shared.status, 200);
        assert.match(shared.body, /mountIconButtons/);
        assert.match(shared.body, /mountButtons/);
    } finally {
        await s.close();
    }
});

test("host-config never replaces a bridge a preload already provided", async () => {
    /* The same bundle is loaded two ways. The embedded frame has no preload, so
     * it needs the postMessage bridge this file installs. The detached window is
     * a top-level WINDOW with a preload, so it already has a real IPC bridge and
     * has no parent to postMessage at — assigning over that would swap a working
     * bridge for one talking into the void, and the buttons would still render,
     * so it would fail silently. */
    const s = await listen();
    try {
        const cfg = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/host-config.js");
        assert.equal(cfg.status, 200);
        assert.match(cfg.body, /if \(!window\.pikvmPanel\) \{/);
        // And it still installs one when there is nothing there.
        assert.match(cfg.body, /setSide: function \(side\)/);
        assert.match(cfg.body, /toggleDetached: function \(\)/);
    } finally {
        await s.close();
    }
});

test("the shared mounts render synchronously", async () => {
    /* React schedules a render; it does not perform one. The console rebuilds a
     * row and then, in the same tick, looks the new controls up by attribute to
     * put focus back where it was — so a scheduled render leaves it searching a
     * DOM that has not been written, and focus quietly lands on the body. That
     * is worst exactly where it matters: building a chord means pressing several
     * modifier toggles in a row, each one triggering a save and a repaint.
     *
     * Verified live rather than only here: clicking the preview toggle and
     * reading its label with no await at all already shows the new one. */
    const s = await listen();
    try {
        const shared = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/shared.js");
        assert.equal(shared.status, 200);
        assert.match(shared.body, /flushSync/);
    } finally {
        await s.close();
    }
});

test("host-config applies the theme itself, without waiting for the app", async () => {
    /* The app follows the console's theme from a React hook, so the class was
     * only set once the workspace shell had mounted. Everything before that —
     * and everything if it never mounts, which is what happens while the daemon
     * is down, a state this window has a status pill for — kept the hardcoded
     * class="dark" from the markup: a light console with a black panel beside it.
     *
     * This file runs before the app module and needs nothing from it, so the
     * theme has to land here rather than only being handed to subscribers. And
     * it has to ASK on load: a reply that only arrives when something subscribes
     * is no use when nothing ever does. */
    const s = await listen();
    try {
        const cfg = await fetchRaw(s.origin, WORKSPACE_PREFIX + "/host-config.js");
        assert.equal(cfg.status, 200);
        assert.match(cfg.body, /classList\.toggle\("dark", d\.value !== "light"\)/);
        // Asked for unconditionally, not only from inside sub().
        const outsideSub = cfg.body.slice(cfg.body.indexOf("window.addEventListener"));
        assert.match(outsideSub, /\n\s*post\("subscribe"\);/);
    } finally {
        await s.close();
    }
});

/**
 * A render error in the panel must not leave the pane blank.
 *
 * There was no error boundary anywhere in this app, so a single throw during
 * render unmounted the whole tree: #root with zero children, no message, no
 * retry, indistinguishable from a pane that had not loaded. Reproduced by
 * answering /api/runs with an object where the frontend types RunSummary[] —
 * "runs.map is not a function" inside a useMemo — which is the realistic
 * failure, since this bundle ships in the desktop app while the daemon is a
 * separate process on its own cadence.
 *
 * What makes it worse than an ordinary crash is the titlebar beside it: the
 * readiness pill polls /daemon/status, which answers fine, so the window read
 * "Agent ready" over a pane showing nothing. Verified after: the pane shows the
 * message and a Try again button, and the pill still says "Agent ready" —
 * which is now a disagreement the user can see rather than one they cannot.
 */
test("the conversation panel says so when it cannot render", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const root = process.cwd();
    const main = readFileSync(resolve(root, "agent/frontend/src/main.tsx"), "utf8");
    const boundary = readFileSync(
        resolve(root, "agent/frontend/src/components/workspace/workspace-error-boundary.tsx"),
        "utf8",
    );

    // Wrapped OUTSIDE the shell: the throw that prompted this came from a
    // useMemo inside it, so a boundary within would have gone down with it.
    assert.match(main, /<WorkspaceErrorBoundary>\s*<WorkspaceShell \/>\s*<\/WorkspaceErrorBoundary>/);
    assert.match(boundary, /static getDerivedStateFromError/);
    assert.match(boundary, /componentDidCatch/);
    // An alert, so it is announced rather than only drawn.
    assert.match(boundary, /role="alert"/);
    // It names the likely cause instead of shrugging, and shows what threw.
    assert.match(boundary, /The conversation could not be displayed/);
    assert.match(boundary, /version mismatch/);
    assert.match(boundary, /\{error\.message\}/);
    // And offers a way out that does not need the window restarting.
    assert.match(boundary, /Try again/);
    assert.match(boundary, /this\.setState\(\{ error: null \}\)/);
    // The built bundle is what actually ships, so it has to carry the string.
    const built = readFileSync(resolve(root, "agent/pikvm_agent/harness_ui/app.js"), "utf8");
    assert.ok(
        built.includes("The conversation could not be displayed"),
        "the workspace bundle is stale — rebuild agent/frontend",
    );
});

/**
 * A run id that is not a run id must not poison the session.
 *
 * sessionStorage.setItem stringifies whatever it is handed, so one call with
 * undefined writes the literal "undefined" — and that is truthy, so every later
 * load treats it as the selected run, fetches /api/runs/undefined, takes the
 * 404 and comes up on "Task unavailable" with no composer at all. Nothing
 * cleared it and sessionStorage outlives a reload, so the panel stayed unusable
 * for the life of the window.
 *
 * Observed exactly that while driving the panel: pikvm-harness-selected-run =
 * "undefined" and GET /api/runs/undefined on every load. Verified after, with a
 * session poisoned before the app booted: no such request, the key removed, and
 * the composer present on the ordinary empty state.
 */
test("a bad stored run id is neither written nor obeyed", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const root = process.cwd();
    const api = readFileSync(resolve(root, "agent/frontend/src/lib/harness-api.ts"), "utf8");
    const hook = readFileSync(resolve(root, "agent/frontend/src/hooks/use-harness-workspace.ts"), "utf8");

    // One predicate, used by both sides.
    assert.match(api, /const usableRunId = \(value: unknown\): value is string =>/);
    assert.match(api, /value !== "undefined"/);
    assert.match(api, /value !== "null"/);
    assert.match(api, /typeof value === "string"/);
    assert.match(api, /value\.length > 0/);
    // The write clears rather than storing rubbish.
    assert.match(api, /if \(!usableRunId\(runId\)\) \{\s*store\.removeItem\(SELECTED_RUN_KEY\);/);
    // The read heals a session that already carries one.
    assert.match(api, /if \(usableRunId\(stored\)\) return stored;/);
    assert.match(api, /store\?\.removeItem\(SELECTED_RUN_KEY\);/);
    /* And selectRun refuses it too. Its id comes from the assistant-ui thread
       adapter, which is outside this codebase, so it is only as typed as that
       library's callback — the guard stops a pointless request as well. */
    assert.match(hook, /if \(!runId\) return;\s*autoFollowExternalRunRef\.current = false;/);
});

test("an unrestorable task is reported once, by the surface that can act on it", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const root = process.cwd();
    const shell = readFileSync(resolve(root, "agent/frontend/src/components/workspace/workspace-shell.tsx"), "utf8");
    const card = readFileSync(resolve(root, "agent/frontend/src/components/workspace/task-restore-state.tsx"), "utf8");
    /* One failure, told three times: a destructive "Task unavailable" badge in
       the header, the restore card, and between them an Alert carrying whatever
       string the daemon put in `detail`. Reproduced by restarting the daemon
       with a run id still in sessionStorage, which is the ordinary way to reach
       this state — the loudest text on screen was "no such run", lowercase and
       unpunctuated, above a card that explained the same thing in English. */
    assert.match(shell, /workspace\.error && workspace\.connected && !selectedRunPending \?/);
    // The daemon's words survive as the card's detail, because they are the one
    // useful lead in a bug report — just not as the headline.
    assert.match(shell, /detail=\{workspace\.error\}/);
    assert.match(card, /\{!restoring && detail \?/);

    /* The copy named two actions the screen did not offer. The composer is
       disabled while a task is unrestorable, so "retry it or start a new task"
       was advice with nothing to press. */
    assert.match(card, /Try again/);
    assert.match(card, /Start a new task/);
    assert.match(shell, /onRetry=\{\(\) => \{[\s\S]*?void workspace\.selectRun\(workspace\.selectedId\);/);
    assert.match(shell, /onNewTask=\{workspace\.newThread\}/);
    // An unrestorable task is an alert; one still coming back is only a status.
    assert.match(card, /role=\{restoring \? "status" : "alert"\}/);

    /* And it has no title to show: selectedTaskTitle falls back to the literal
       words "New task", which printed in the card read as the task's own name.
       The id is the one thing actually known about it. */
    assert.match(shell, /task=\{\s*workspace\.selectedRun\?\.task \|\| selectedSummary\?\.task\s*\}/);
    assert.match(shell, /runId=\{workspace\.selectedId\}/);
    assert.match(card, /\) : runId \? \(/);
    /* Driven over CDP with a stale id seeded into sessionStorage: the card came
       up as role=alert reading "Task unavailable / r-gone-42 / The saved
       conversation could not be loaded… / no such run", no banner beside it,
       Try again re-attempted and landed back on the same card, and Start a new
       task cleared the stored id and returned an enabled composer. */
});

test("a sheet that cannot render fails inside itself, not over the workspace", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const root = process.cwd();
    const shell = readFileSync(resolve(root, "agent/frontend/src/components/workspace/workspace-shell.tsx"), "utf8");
    const boundary = readFileSync(
        resolve(root, "agent/frontend/src/components/workspace/workspace-error-boundary.tsx"),
        "utf8",
    );
    const showcase = readFileSync(resolve(root, "agent/frontend/src/components/workspace/showcase-sheet.tsx"), "utf8");
    /* One boundary at the root was not enough. Opening Recorded proof against a
       daemon that answered /api/showcases/current with a different shape threw
       during render — "TypeError: e.tasks is not iterable" — and with nothing
       between that sheet and the root the whole workspace went: conversation,
       sidebar and composer replaced by the root boundary's message, over a
       panel someone opened out of curiosity. */
    for (const scope of ["computer", "models", "diagnostics", "recorded-proof"]) {
        assert.match(shell, new RegExp(`scope="${scope}"`), `${scope} sheet needs its own boundary`);
    }
    assert.equal((shell.match(/<WorkspaceErrorBoundary/g) ?? []).length, 4, "one per lazily-mounted sheet");

    /* The failure is drawn as the sheet the user opened. Its children render at
       the end of the shell's tree, so the boundary's own centred panel would
       have appeared loose in the layout with nothing to close. */
    assert.match(boundary, /fallback\?: \(error: Error, reset: \(\) => void\) => ReactNode;/);
    assert.match(boundary, /if \(this\.props\.fallback\) return this\.props\.fallback\(error, this\.reset\);/);
    assert.match(shell, /function SheetFailure\(\{/);
    assert.match(shell, /onRetry=\{reset\}/);
    // Closing it clears the caught error too, so reopening the sheet retries
    // rather than showing the same corpse.
    assert.match(shell, /onOpenChange=\{\(next\) => \{\s*if \(!next\) onRetry\(\);/);
    // The root boundary keeps its conversation wording; the sheets name themselves.
    assert.match(boundary, /const DEFAULT_TITLE = "The conversation could not be displayed";/);
    assert.match(boundary, /\{this\.props\.title \?\? DEFAULT_TITLE\}/);

    /* And the sheet stops trusting a shape it cannot guarantee: this panel ships
       in the desktop app while the daemon is a separate process on its own
       release cadence, so either can be newer. */
    assert.match(showcase, /const isCampaign = \(value: unknown\): value is ShowcaseCampaign =>/);
    assert.match(showcase, /Array\.isArray\(\(value as \{ tasks\?: unknown \}\)\.tasks\)/);
    assert.match(showcase, /const next = await harnessJson<unknown>\(/);
    assert.match(showcase, /if \(!isCampaign\(next\)\) \{/);
    /* Re-driven over CDP against the same daemon answer: the sheet opened on
       "Evidence feed unavailable" with the version-mismatch line, its Close
       focused, and the conversation, sidebar and composer intact behind it. */
});

test("the task list can tell one run from another", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const root = process.cwd();
    const shell = readFileSync(resolve(root, "agent/frontend/src/components/workspace/workspace-shell.tsx"), "utf8");
    const listPath = resolve(root, "agent/frontend/src/components/assistant-ui/thread-list.tsx");
    const threadList = readFileSync(listPath, "utf8");
    /* The task list is the one place you go to find a task again, and it showed
       nothing but a truncated title. Seen with five runs open — failed,
       aborted, blocked, rejected and paused — as five identical rows.

       Its relative time and its Today/Yesterday grouping were already written
       and styled, both reading item.lastMessageAt. ExternalStoreThreadData has
       no such field, so the external-store runtime can never set it: two
       features had been dark since the day they were added. */
    assert.doesNotMatch(threadList, /item\.lastMessageAt/, "the runtime can never set it");
    assert.match(shell, /custom: \{ updatedAt: run\.updated_at, runStatus: run\.status \}/);
    assert.match(threadList, /runUpdatedAt\(itemsById\.get\(id\)\?\.custom\)/);
    assert.match(threadList, /useThreadListItem\(\(item\) => runUpdatedAtRaw\(item\.custom\)\)/);
    assert.match(threadList, /useThreadListItem\(\(item\) => runStateLabel\(item\.custom\)\)/);

    /* The selector hands back the raw string, not a Date. useThreadListItem
       compares what the selector returns, and a fresh object every call
       re-rendered forever — measured: the panel came up on the root error
       boundary instead of a task list. */
    assert.match(threadList, /export const runUpdatedAtRaw = \(custom: Record<string, unknown> \| undefined\) =>\s*typeof custom\?\.updatedAt === "string" \? custom\.updatedAt : undefined;/);

    // Only the states worth interrupting a scan for; queued, running and
    // finished say nothing, or the marker would mean nothing.
    for (const [status, label] of [["needs_approval", "Review"], ["failed", "Failed"],
        ["blocked", "Blocked"], ["rejected", "Denied"], ["aborted", "Stopped"], ["paused", "Paused"]]) {
        assert.match(threadList, new RegExp(`${status}: \\{ label: "${label}"`), `${status} needs a marker`);
    }
    assert.doesNotMatch(threadList, /\b(running|completed|queued): \{ label:/);
    /* Rendered over CDP at 400px with all six seeded: a "Today" header, then
       Review / Paused / Denied / Blocked / Stopped / Failed each beside a "1m",
       measured at 5.07–5.69:1 in the dark theme and 4.71–5.71:1 in the light —
       AA at 11px in both. */
});
