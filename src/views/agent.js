/*
 * Native Agent panel — front-end for the pikvm-agent daemon.
 *
 * Served from the app's own origin; talks to the daemon through the same-origin
 * reverse proxy at /_agent/daemon/*. The daemon has no SSE/WebSocket, so we POLL.
 *
 * Responsiveness: clicking a session renders instantly from the cached list entry,
 * then fetches detail + trace + approvals IN PARALLEL (not three serial round-trips).
 * The status GET is read-only on the daemon, so polling is cheap.
 *
 * Legibility: the raw trace event kinds (observe / decision / executed …) are
 * translated into plain language, and a "current activity" line says what the agent
 * is doing right now.
 */
(function () {
    "use strict";

    var DAEMON = "/_agent/daemon";
    var POLL_MS = 1200;

    var state = {
        sessions: [],
        selectedId: null,
        offline: false,
        busy: false,        // a continue/abort/approval POST is in flight
        lastFrameId: null,
        ticking: false,     // guards overlapping poll cycles
        tickN: 0,
    };

    var el = {
        offline: document.getElementById("offline"),
        form: document.getElementById("new-task"),
        taskInput: document.getElementById("task-input"),
        taskStart: document.getElementById("task-start"),
        sessionsEmpty: document.getElementById("sessions-empty"),
        sessionsList: document.getElementById("sessions-list"),
        detail: document.getElementById("detail"),
        dTask: document.getElementById("d-task"),
        dStatus: document.getElementById("d-status"),
        dSteps: document.getElementById("d-steps"),
        dError: document.getElementById("d-error"),
        dFrame: document.getElementById("d-frame"),
        dFrameEmpty: document.getElementById("d-frame-empty"),
        dContinue: document.getElementById("d-continue"),
        dAbort: document.getElementById("d-abort"),
        activity: document.getElementById("d-activity"),
        activitySpin: document.getElementById("d-activity-spin"),
        activityIcon: document.getElementById("d-activity-icon"),
        activityText: document.getElementById("d-activity-text"),
        approval: document.getElementById("approval"),
        aRisk: document.getElementById("a-risk"),
        aReason: document.getElementById("a-reason"),
        aAction: document.getElementById("a-action"),
        aReasonInput: document.getElementById("a-reason-input"),
        aApprove: document.getElementById("a-approve"),
        aReject: document.getElementById("a-reject"),
        trace: document.getElementById("d-trace"),
    };

    // ---- daemon API (through the proxy) ----------------------------------------
    async function api(path, opts) {
        var r = await fetch(DAEMON + path, opts);
        var text = await r.text();
        if (!r.ok) {
            var msg = "HTTP " + r.status;
            try { var j = JSON.parse(text); msg = j.detail || j.error || msg; } catch (e) { /* not json */ }
            var err = new Error(msg);
            err.status = r.status;
            throw err;
        }
        try { return JSON.parse(text); } catch (e) { return text; }
    }

    function setOffline(off) {
        if (state.offline === off) return;
        state.offline = off;
        el.offline.hidden = !off;
    }

    // ---- status helpers --------------------------------------------------------
    function statusClass(s) {
        if (s === "running") return "running";
        if (s === "needs_approval") return "needs_approval";
        if (s === "paused") return "paused";
        if (s === "done") return "done";
        if (s === "failed") return "failed";
        return "";
    }
    function statusLabel(s) {
        if (s === "needs_approval") return "needs approval";
        return s || "—";
    }

    // ---- sessions list ---------------------------------------------------------
    function renderSessions() {
        var list = state.sessions;
        el.sessionsEmpty.hidden = list.length > 0;
        el.sessionsList.innerHTML = "";
        list.forEach(function (s) {
            var live = s.live_status || s.status;
            var li = document.createElement("li");
            if (s.id === state.selectedId) li.className = "active";
            var dot = document.createElement("span");
            dot.className = "dot " + statusClass(live);
            if (live === "running") dot.classList.add("pulse");
            var task = document.createElement("span");
            task.className = "s-task";
            task.textContent = s.task || "(no task)";
            task.title = s.task || "";
            var id = document.createElement("span");
            id.className = "s-id";
            id.textContent = (s.id || "").replace(/^s_/, "").slice(0, 6);
            li.appendChild(dot); li.appendChild(task); li.appendChild(id);
            li.addEventListener("click", function () { select(s.id); });
            el.sessionsList.appendChild(li);
        });
    }

    // ---- detail header / current activity -------------------------------------
    function renderHead(snap) {
        el.detail.hidden = false;
        el.dTask.textContent = snap.task || "(no task)";
        var status = snap.status || "—";
        el.dStatus.textContent = statusLabel(status);
        el.dStatus.className = "badge " + statusClass(status);
        var bits = [];
        if (typeof snap.step === "number" && snap.step > 0) bits.push("step " + snap.step);
        if (typeof snap.frame_id === "number") bits.push("frame " + snap.frame_id);
        el.dSteps.textContent = bits.join(" · ");
        if (snap.error) { el.dError.hidden = false; el.dError.textContent = snap.error; }
        else el.dError.hidden = true;
        var terminal = status === "done" || status === "failed";
        el.dContinue.disabled = state.busy || terminal;
        el.dContinue.textContent = status === "paused" ? "Continue ▸" : "Continue";
        el.dAbort.disabled = state.busy || terminal;
    }

    // Plain-language "what is it doing right now", from status + the latest trace.
    function renderActivity(snap, trace) {
        var status = snap && snap.status;
        var spin = false, icon = "•", text = "…", cls = "";
        if (status === "needs_approval") {
            icon = "⏳"; text = "Waiting for your approval"; cls = "warn";
        } else if (status === "paused") {
            icon = "⏸"; text = "Paused — press Continue to keep going"; cls = "muted";
        } else if (status === "done") {
            icon = "✓"; text = "Task complete"; cls = "ok";
        } else if (status === "failed") {
            icon = "✕"; text = "Failed" + (snap.error ? " — " + snap.error : ""); cls = "err";
        } else if (status === "running") {
            spin = true; cls = "run";
            var last = trace && trace.length ? trace[trace.length - 1] : null;
            var decision = latestOf(trace, "decision");
            if (last && last.kind === "operator_error") {
                icon = "⚠"; text = "Model hiccup — retrying…"; cls = "warn"; spin = true;
            } else if (decision && decision.intent) {
                icon = "🧠"; text = "Working on: " + decision.intent;
            } else {
                icon = "👁"; text = "Looking at the screen…";
            }
        } else {
            text = status ? String(status) : "…";
        }
        el.activitySpin.hidden = !spin;
        el.activityIcon.hidden = spin;
        el.activityIcon.textContent = icon;
        el.activityText.textContent = text;
        el.activity.className = "activity " + cls;
    }

    function latestOf(trace, kind) {
        if (!trace) return null;
        for (var i = trace.length - 1; i >= 0; i--) if (trace[i].kind === kind) return trace[i];
        return null;
    }

    // ---- activity log (human-readable trace) ----------------------------------
    // Map a raw trace event to {icon, text, cls}. Returns null to hide it.
    function describe(e) {
        var k = e.kind;
        switch (k) {
            case "session_start": return { icon: "▶", text: "Task started", cls: "" };
            case "observe": return { icon: "·", text: "Observed the screen", cls: "dim" };
            case "parse_skipped": return null; // pure noise
            case "decision":
                var acts = Array.isArray(e.actions) && e.actions.length ? "  [" + e.actions.join(", ") + "]" : "";
                return { icon: "🧠", text: "Plan: " + (e.intent || "(no intent)") + acts, cls: "plan" };
            case "executed":
                var failed = e.status && /fail|block/i.test(e.status);
                var ran = Array.isArray(e.actions) && e.actions.length ? e.actions.join(", ") : "action";
                return { icon: failed ? "✗" : "✓", text: "Ran " + ran + (e.status ? " (" + e.status + ")" : ""), cls: failed ? "err" : "ok" };
            case "execute_refused": return { icon: "⛔", text: "Refused: " + (e.reason || ""), cls: "warn" };
            case "execute_deferred": return { icon: "⏸", text: "Deferred (time budget)", cls: "dim" };
            case "approval_required": return { icon: "⏳", text: "Needs approval: " + (e.reason || ""), cls: "warn" };
            case "policy_block": return { icon: "⛔", text: "Blocked by policy: " + (e.reason || ""), cls: "warn" };
            case "operator_error": return { icon: "⚠", text: "Model error: " + (e.error || ""), cls: "err" };
            case "budget_pause": return { icon: "⏸", text: "Paused (step budget reached)", cls: "dim" };
            case "max_steps_exhausted": return { icon: "⚠", text: "Hit the step limit", cls: "err" };
            case "recover": return { icon: "↺", text: "Recovering" + (e.mode ? " (" + e.mode + ")" : ""), cls: "warn" };
            case "abort": return { icon: "✕", text: "Aborted" + (e.reason ? ": " + e.reason : ""), cls: "err" };
            case "panic_stop": return { icon: "■", text: "EMERGENCY STOP", cls: "err" };
            default:
                var hint = e.reason || e.detail || e.message || e.status || "";
                return { icon: "·", text: k + (hint ? ": " + String(hint).slice(0, 80) : ""), cls: "dim" };
        }
    }

    function hhmmss(t) {
        return (t || "").replace("T", " ").replace(/\..*$/, "").slice(11);
    }

    function renderTrace(entries) {
        el.trace.innerHTML = "";
        var items = entries || [];
        // Collapse runs of consecutive low-signal "observe" entries into one line.
        var rows = [];
        items.forEach(function (e) {
            var d = describe(e);
            if (!d) return;
            var prev = rows[rows.length - 1];
            if (e.kind === "observe" && prev && prev.kind === "observe") {
                prev.count++; prev.t = e.t;
                return;
            }
            rows.push({ kind: e.kind, d: d, t: e.t, count: 1 });
        });
        rows.slice().reverse().forEach(function (r) {
            var li = document.createElement("li");
            li.className = "ev " + (r.d.cls || "");
            var ic = document.createElement("span"); ic.className = "ev-ic"; ic.textContent = r.d.icon;
            var tx = document.createElement("span"); ic.setAttribute("aria-hidden", "true");
            tx.className = "ev-tx";
            tx.textContent = r.d.text + (r.count > 1 ? "  ×" + r.count : "");
            var tm = document.createElement("time"); tm.textContent = hhmmss(r.t);
            li.appendChild(ic); li.appendChild(tx); li.appendChild(tm);
            el.trace.appendChild(li);
        });
        if (!rows.length) {
            var li2 = document.createElement("li");
            li2.className = "ev dim";
            li2.textContent = "No activity yet.";
            el.trace.appendChild(li2);
        }
    }

    function updateFrame(id, frameId) {
        if (!id) return;
        if (frameId == null || frameId === state.lastFrameId) return;
        state.lastFrameId = frameId;
        el.dFrame.onerror = function () { el.dFrame.style.display = "none"; el.dFrameEmpty.style.display = "flex"; };
        el.dFrame.onload = function () { el.dFrame.style.display = "block"; el.dFrameEmpty.style.display = "none"; };
        el.dFrame.src = DAEMON + "/sessions/" + id + "/frame?f=" + frameId;
    }

    function renderApproval(approvals) {
        var pending = (approvals || []).find ? (approvals || []).find(function (a) { return a.status === "pending"; }) : null;
        if (!pending) { el.approval.hidden = true; el.approval.dataset.id = ""; return; }
        el.approval.hidden = false;
        var req = pending.request || {};
        el.approval.dataset.id = pending.id;
        el.aRisk.textContent = req.risk || "review";
        el.aReason.textContent = req.reason || "";
        el.aAction.textContent = JSON.stringify(req.proposed_action || {}, null, 2);
    }

    // ---- data flow -------------------------------------------------------------
    async function refreshSessions() {
        try {
            var sessions = await api("/sessions");
            setOffline(false);
            state.sessions = Array.isArray(sessions) ? sessions : [];
            renderSessions();
        } catch (e) {
            if (e.status === 502) setOffline(true);
        }
    }

    async function refreshDetail() {
        var id = state.selectedId;
        if (!id) { el.detail.hidden = true; return; }
        // Fetch the three detail pieces IN PARALLEL (was three serial round-trips).
        var res = await Promise.allSettled([
            api("/sessions/" + id),
            api("/sessions/" + id + "/trace"),
            api("/sessions/" + id + "/approvals"),
        ]);
        if (state.selectedId !== id) return; // selection changed mid-flight
        var snapR = res[0], traceR = res[1], apprR = res[2];
        if (snapR.status === "rejected") {
            var err = snapR.reason || {};
            if (err.status === 502) setOffline(true);
            else if (err.status === 404) { state.selectedId = null; el.detail.hidden = true; }
            return;
        }
        setOffline(false);
        var snap = snapR.value;
        var trace = traceR.status === "fulfilled" && Array.isArray(traceR.value) ? traceR.value : [];
        renderHead(snap);
        renderActivity(snap, trace);
        updateFrame(id, snap.frame_id);
        if (traceR.status === "fulfilled") renderTrace(trace);
        if (apprR.status === "fulfilled") renderApproval(apprR.value);
    }

    function select(id) {
        if (state.selectedId === id) return;
        state.selectedId = id;
        state.lastFrameId = null;
        renderSessions();
        // INSTANT: paint from the cached list entry so the panel switches with no wait,
        // then fill in detail/trace/frame from the network.
        var cached = state.sessions.filter(function (s) { return s.id === id; })[0];
        if (cached) {
            renderHead({ task: cached.task, status: cached.live_status || cached.status, error: "" });
            renderActivity({ status: cached.live_status || cached.status }, []);
        } else {
            el.detail.hidden = false;
        }
        el.trace.innerHTML = "";
        el.approval.hidden = true;
        refreshDetail();
    }

    async function withBusy(fn) {
        if (state.busy) return;
        state.busy = true;
        el.dContinue.disabled = el.dAbort.disabled = true;
        try { await fn(); }
        catch (e) { if (e.status === 502) setOffline(true); else if (el.dError) { el.dError.hidden = false; el.dError.textContent = e.message; } }
        finally { state.busy = false; await refreshDetail(); refreshSessions(); }
    }

    // ---- actions ---------------------------------------------------------------
    el.form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var task = el.taskInput.value.trim();
        if (!task) return;
        el.taskStart.disabled = true;
        api("/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ task: task, policy: {}, operator: {} }),
        }).then(function (res) {
            el.taskInput.value = "";
            return refreshSessions().then(function () { if (res && res.session_id) select(res.session_id); });
        }).catch(function (e) {
            if (e.status === 502) setOffline(true);
        }).finally(function () { el.taskStart.disabled = false; });
    });

    el.dContinue.addEventListener("click", function () {
        var id = state.selectedId; if (!id) return;
        withBusy(function () { return api("/sessions/" + id + "/continue", { method: "POST" }); });
    });

    el.dAbort.addEventListener("click", function () {
        var id = state.selectedId; if (!id) return;
        withBusy(function () {
            return api("/sessions/" + id + "/abort", {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "aborted from panel" }),
            });
        });
    });

    // Emergency brake — halt every session at once, no agent involved. No confirm.
    var panicBtn = document.getElementById("panic-stop");
    if (panicBtn) {
        panicBtn.addEventListener("click", function () {
            panicBtn.classList.add("armed");
            api("/panic-stop", { method: "POST" })
                .catch(function () { /* daemon down → nothing to stop */ })
                .finally(function () {
                    setTimeout(function () { panicBtn.classList.remove("armed"); }, 600);
                    refreshSessions(); refreshDetail();
                });
        });
    }

    function resolveApproval(type) {
        var id = state.selectedId;
        var aid = el.approval.dataset.id;
        if (!id || !aid) return;
        var reason = el.aReasonInput.value.trim();
        var body = { type: type };
        if (reason) { body.reason = reason; body.instruction = reason; }
        withBusy(function () {
            return api("/sessions/" + id + "/approvals/" + aid, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
            }).then(function () { el.aReasonInput.value = ""; });
        });
    }
    el.aApprove.addEventListener("click", function () { resolveApproval("approve"); });
    el.aReject.addEventListener("click", function () { resolveApproval("reject"); });

    // ---- poll loop -------------------------------------------------------------
    // One non-overlapping cycle. Detail (cheap, read-only) refreshes every tick;
    // the session list every 2nd tick.
    async function tick() {
        if (state.ticking) return;
        state.ticking = true;
        try {
            state.tickN++;
            if (state.tickN % 2 === 1) await refreshSessions();
            if (state.selectedId) await refreshDetail();
        } finally {
            state.ticking = false;
        }
    }
    refreshSessions().then(tick);
    setInterval(tick, POLL_MS);
})();
