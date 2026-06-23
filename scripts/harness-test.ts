// Harness regression tests — drive the REAL server-side plumbing through the exact
// failure modes that have bitten us in production, so they're caught here instead of in
// the user's logs. No Electron, no LLM: these bugs all lived in deterministic logic
// (auth-id generation, the approval-gate UI reconciliation, the live broadcast replay,
// the hard-stop gate). Each test asserts the FIXED behaviour AND documents the old break.
//
//   esbuild scripts/harness-test.ts --bundle --platform=node --format=cjs \
//     --alias:electron=./scripts/electron-stub.cjs --outfile=dist/harness-test.cjs \
//     && node dist/harness-test.cjs

import { OperationReviewer } from "../src/reviewer";
import type { AuthRequest } from "../src/reviewer";
import { ChatBroadcast } from "../src/agent/broadcast";
import { pickPendingAuth, pruneDecided, isAuthHandled } from "../src/agent/auth-ui";
import { isStaleUiSave } from "../src/agent/session-sync";
import { isTransientModelError } from "../src/agent/runner";
import { friendlyAgentError } from "../src/agent/ui-stream";

let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
    if (cond) console.log(`  ok   ${name}`);
    else {
        failed++;
        console.log(`  FAIL ${name}`, extra ?? "");
    }
}

// A fake SSE response that records what was written (enough for ChatBroadcast).
function fakeRes() {
    const writes: string[] = [];
    return { writes, write: (s: string) => (writes.push(s), true), on: () => {}, writableLength: 0, destroy: () => {} } as any;
}
const parseEvents = (res: { writes: string[] }) =>
    res.writes.map((s) => { try { return JSON.parse(s.replace(/^data: /, "")); } catch { return null; } }).filter(Boolean);

// Drive a real Reviewer through one request_approval, returning the id it minted.
async function requestApproval(rv: OperationReviewer, action: string): Promise<string> {
    let seen = "";
    rv.setPrompter(async (req: AuthRequest) => { seen = req.id; return { decision: "allow" }; });
    const verdict = await rv.review({ tool: "request_approval", args: { action } } as any);
    check(`  (request_approval "${action}" resolves allow)`, verdict.decision === "allow", verdict);
    return seen;
}

async function main() {
    console.log("auth ids: unique across runs/sessions (the silent-hang root cause)");
    {
        // Two reviewers = two sessions (e.g. an app restart, or a new session recreating
        // the reviewer). The OLD per-instance `op_${seq}` reset to op_1 each time → the id
        // collided with a client's remembered decision and the prompt never showed.
        const r1 = new OperationReviewer();
        const r2 = new OperationReviewer();
        const idA = await requestApproval(r1, "send the email");
        const idB = await requestApproval(r2, "submit the form");
        const idC = await requestApproval(r1, "post the message");
        check("ids are non-empty", !!idA && !!idB && !!idC, { idA, idB, idC });
        check("ids unique across two reviewer instances", new Set([idA, idB, idC]).size === 3, { idA, idB, idC });
    }

    console.log("approval gate: a fresh request is actionable even with stale `decided`");
    {
        // The full bug: the user approved run 1 (id1 → decided), then run 2 asks again.
        const r1 = new OperationReviewer();
        const r2 = new OperationReviewer();
        const id1 = await requestApproval(r1, "run 1 action");
        const id2 = await requestApproval(r2, "run 2 action");
        const decided = new Set([id1]); // remembered from run 1, never cleared
        const req2: AuthRequest = { id: id2, op: { tool: "request_approval", args: { action: "run 2 action" } }, risky: true, kind: "approval" } as any;
        const picked = pickPendingAuth({ pendingAuths: [req2], pendingAuthIds: [id2], decided, messageAuths: [] });
        check("run 2's prompt IS surfaced (no hang)", picked?.id === id2, { id1, id2, picked });

        // The occluded-renderer freeze case: the /api/state poll is frozen mid-run, so
        // pendingAuths/pendingAuthIds are EMPTY — but the data-auth arrived via the live
        // message stream and a run is busy. The prompt MUST still surface from the message.
        const frozen = pickPendingAuth({ pendingAuths: [], pendingAuthIds: [], decided: new Set(), messageAuths: [req2], busy: true });
        check("frozen poll + live run → prompt surfaces from the message stream", frozen?.id === id2, { frozen });
        // …but a reloaded transcript (NOT busy) with the same stale message must NOT.
        const idle = pickPendingAuth({ pendingAuths: [], pendingAuthIds: [], decided: new Set(), messageAuths: [req2], busy: false });
        check("idle (reloaded transcript) → stale auth does NOT reappear", idle === null, { idle });

        // Regression guard: prove the test WOULD catch a reused id. If id2 collided with
        // id1, the stale `decided` would swallow it → null → the exact hang.
        const collided = pickPendingAuth({ pendingAuths: [{ ...req2, id: id1 }], pendingAuthIds: [id1], decided, messageAuths: [] });
        check("(guard) a reused id WOULD hang — picker returns null", collided === null, { collided });
    }

    console.log("pruneDecided: never lets the decided-set go stale");
    {
        const decided = new Set(["op_1_old", "op_2_live"]);
        const pruned = pruneDecided(decided, ["op_2_live"]); // server only still-pending: op_2
        check("drops ids the server no longer lists pending", !pruned.has("op_1_old") && pruned.has("op_2_live"), [...pruned]);
        const same = pruneDecided(new Set(["x"]), ["x"]);
        check("returns same set when unchanged (no setState loop)", pruneDecided(same, ["x"]) === same);
        check("isAuthHandled: pending → not handled", isAuthHandled("op_9", ["op_9"], new Set()) === false);
        check("isAuthHandled: gone from pending → handled", isAuthHandled("op_9", [], new Set()) === true);
    }

    console.log("reviewer.assess: drives Claude Code's permission decisions (allow/ask)");
    {
        const rv = new OperationReviewer(); // default policy risky-only, autonomy 3
        const safeMove = rv.assess({ tool: "move_mouse", args: { x: 10, y: 10 }, source: "mcp" } as any);
        check("a plain mouse move → allow (auto-run, no prompt)", safeMove.decision === "allow", safeMove);
        const sensitive = rv.assess({ tool: "type_text", args: { text: "hi" }, source: "mcp", sensitive: { app: "Teams", reason: "message compose box" } } as any);
        check("typing in a sensitive area → ask (terminal prompt)", sensitive.decision === "ask", sensitive);
        const danger = rv.assess({ tool: "press_key", args: { key: "Enter" }, source: "mcp", commandText: "sudo rm -rf /var" } as any);
        check("Enter that submits `sudo rm -rf` → ask, with a reason", danger.decision === "ask" && !!danger.reason, danger);
    }

    console.log("provider errors: classified for retry/fallback, and surfaced (never silent)");
    {
        const overload = 'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}';
        check("the real codex overload IS transient (→ fallback)", isTransientModelError(overload) === true);
        check("rate-limit is transient", isTransientModelError("429 rate limit exceeded") === true);
        check("timeout is transient", isTransientModelError("request timed out (ETIMEDOUT)") === true);
        check("explicit 'status 503' is transient", isTransientModelError("upstream returned status 503") === true);
        check("bad API key is NOT transient (don't retry — surface to fix)", isTransientModelError("401 invalid api key") === false);
        check("no quota is NOT transient", isTransientModelError("insufficient_quota: billing") === false);
        // Regex must not false-positive on a stray 3-digit number in the message body.
        check("a stray 5xx-looking number is NOT transient", isTransientModelError("context length 512 exceeded for this request") === false);
        check("'max_tokens must be <= 580' is NOT transient", isTransientModelError("max_tokens must be <= 580") === false);
        // Surfacing: the user must SEE something actionable, never silence.
        check("overload yields a visible, actionable message", /overloaded/i.test(friendlyAgentError(overload)) && friendlyAgentError(overload).length > 20);
        check("auth error points at Settings", /key|login|settings|credential/i.test(friendlyAgentError("401 unauthorized")));
        check("unknown error still surfaces SOMETHING (not empty)", friendlyAgentError("weird boom").length > 10);
    }

    console.log("new chat: a stale transcript save can't bleed into the new session");
    {
        // The client tags a persist with the session those messages belong to. After "+",
        // the server is on a new session; a trailing save tagged for the OLD one is dropped.
        check("save tagged for the PREVIOUS session is rejected", isStaleUiSave("sess_old", "sess_new") === true);
        check("save tagged for the CURRENT session is accepted", isStaleUiSave("sess_new", "sess_new") === false);
        check("untagged save (legacy client) is accepted", isStaleUiSave(undefined, "sess_new") === false);
    }

    console.log("live broadcast: a mid-run joiner replays the FULL exchange, in order");
    {
        const b = new ChatBroadcast();
        b.add(fakeRes()); // an already-connected client (the actor)
        b.send({ type: "user", id: "u1", clientId: "desktop", text: "do the thing" });
        b.send({ type: "begin", messageId: "live-1-abc", clientId: "desktop" });
        b.send({ type: "text-start", id: "t1" });
        b.send({ type: "text-delta", id: "t1", delta: "Work" });
        b.send({ type: "data-screenshot", id: "s1", data: { src: "IMG" } });
        b.send({ type: "text-delta", id: "t1", delta: "ing" });
        const phone = fakeRes();
        b.add(phone); // joins MID-run
        const got = parseEvents(phone);
        check("replays the starting user prompt first", got[0]?.type === "user" && got[0]?.id === "u1", got[0]);
        check("replays begin with the stable messageId", got.find((c: any) => c.type === "begin")?.messageId === "live-1-abc");
        check("text reconstructs exactly", got.filter((c: any) => c.type === "text-delta").map((c: any) => c.delta).join("") === "Working");
        check("screenshot carried", got.find((c: any) => c.type === "data-screenshot")?.data?.src === "IMG");
        b.send({ type: "end" });
        const late = fakeRes();
        b.add(late);
        check("post-end joiner gets no live replay (uses persisted reload)", parseEvents(late).length === 0);
    }

    console.log("live broadcast: screenshot history is bounded (no unbounded buffer)");
    {
        const b = new ChatBroadcast();
        b.add(fakeRes());
        b.send({ type: "begin", messageId: "m", clientId: "d" });
        for (let i = 0; i < 9; i++) b.send({ type: "data-screenshot", id: "s" + i, data: { src: "IMG" + i } });
        const joiner = fakeRes();
        b.add(joiner);
        const shots = parseEvents(joiner).filter((c: any) => c.type === "data-screenshot");
        const stripped = shots.filter((c: any) => c.data.src === "").length;
        const kept = shots.filter((c: any) => c.data.src !== "").length;
        check("only the recent few screenshots keep image data", kept === 6 && stripped === 3, { kept, stripped });
    }

    console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
    process.exit(failed === 0 ? 0 : 1);
}

void main();
