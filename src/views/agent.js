/*
 * Native Agent panel — front-end for the pikvm-agent daemon.
 *
 * Served from the app's own origin and talks to the daemon through the same-origin
 * reverse proxy at /_agent/daemon/* (so no CORS, and the access token still gates
 * it remotely). The daemon has no SSE/WebSocket, so we POLL: every POLL_MS we
 * refresh the session list and, if one is selected, its state + frame + trace +
 * approvals. When the proxy reports the daemon is down (502) we surface an offline
 * banner and keep retrying.
 */
(function () {
    "use strict";

    var DAEMON = "/_agent/daemon";
    var POLL_MS = 1500;

    var state = {
        sessions: [],
        selectedId: null,
        offline: false,
        busy: false, // a continue/abort/approval POST is in flight
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
            try {
                var j = JSON.parse(text);
                msg = j.detail || j.error || msg;
            } catch (e) { /* not json */ }
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

    // ---- rendering -------------------------------------------------------------
    function statusClass(s) {
        if (s === "running") return "running";
        if (s === "needs_approval") return "needs_approval";
        if (s === "done") return "done";
        if (s === "failed") return "failed";
        return "";
    }

    function renderSessions() {
        var list = state.sessions;
        el.sessionsEmpty.hidden = list.length > 0;
        el.sessionsList.innerHTML = "";
        list.forEach(function (s) {
            var li = document.createElement("li");
            if (s.id === state.selectedId) li.className = "active";
            var live = s.live_status || s.status;
            var dot = document.createElement("span");
            dot.className = "dot " + statusClass(live);
            var task = document.createElement("span");
            task.className = "s-task";
            task.textContent = s.task || "(no task)";
            var id = document.createElement("span");
            id.className = "s-id";
            id.textContent = (s.id || "").replace(/^s_/, "");
            li.appendChild(dot);
            li.appendChild(task);
            li.appendChild(id);
            li.addEventListener("click", function () { select(s.id); });
            el.sessionsList.appendChild(li);
        });
    }

    function renderDetail(snap) {
        if (!snap) { el.detail.hidden = true; return; }
        el.detail.hidden = false;
        el.dTask.textContent = snap.task || "(no task)";
        var status = snap.status || "—";
        el.dStatus.textContent = status;
        var bits = [];
        if (typeof snap.step === "number") bits.push("step " + snap.step);
        if (typeof snap.frame_id === "number") bits.push("frame " + snap.frame_id);
        if (typeof snap.world_version === "number") bits.push("wv " + snap.world_version);
        el.dSteps.textContent = bits.join(" · ");
        if (snap.error) { el.dError.hidden = false; el.dError.textContent = snap.error; }
        else el.dError.hidden = true;
        // Continue only makes sense while there's more to do.
        var terminal = status === "done" || status === "failed";
        el.dContinue.disabled = state.busy || terminal;
        el.dAbort.disabled = state.busy || terminal;
    }

    function renderTrace(entries) {
        el.trace.innerHTML = "";
        (entries || []).slice().reverse().forEach(function (e) {
            var li = document.createElement("li");
            var t = document.createElement("time");
            t.textContent = (e.t || "").replace("T", " ").replace(/\..*$/, "").slice(11);
            var k = document.createElement("span");
            k.className = "tk";
            k.textContent = e.kind || "?";
            li.appendChild(t);
            li.appendChild(k);
            // Append a short hint of any human-readable field.
            var hint = e.reason || e.detail || e.message || e.status || "";
            if (hint) {
                var h = document.createElement("span");
                h.textContent = String(hint).slice(0, 80);
                li.appendChild(h);
            }
            el.trace.appendChild(li);
        });
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

    function updateFrame(id) {
        if (!id) return;
        // Cache-bust so each poll fetches the freshest JPEG; hide on 404/no-frame.
        el.dFrame.onerror = function () { el.dFrame.style.display = "none"; el.dFrameEmpty.style.display = "flex"; };
        el.dFrame.onload = function () { el.dFrame.style.display = "block"; el.dFrameEmpty.style.display = "none"; };
        el.dFrame.src = DAEMON + "/sessions/" + id + "/frame?t=" + Date.now();
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
        try {
            var snap = await api("/sessions/" + id);
            setOffline(false);
            renderDetail(snap);
            updateFrame(id);
        } catch (e) {
            if (e.status === 502) setOffline(true);
            else if (e.status === 404) { state.selectedId = null; el.detail.hidden = true; }
            return;
        }
        // Approvals + trace are best-effort (don't blank the view on a hiccup).
        try { renderApproval(await api("/sessions/" + id + "/approvals")); } catch (e) { /* keep last */ }
        try { renderTrace(await api("/sessions/" + id + "/trace")); } catch (e) { /* keep last */ }
    }

    function select(id) {
        state.selectedId = id;
        renderSessions();
        refreshDetail();
    }

    async function withBusy(fn) {
        if (state.busy) return;
        state.busy = true;
        el.dContinue.disabled = el.dAbort.disabled = true;
        try { await fn(); }
        catch (e) { if (e.status === 502) setOffline(true); else if (el.dError) { el.dError.hidden = false; el.dError.textContent = e.message; } }
        finally { state.busy = false; await refreshDetail(); await refreshSessions(); }
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
    async function tick() {
        await refreshSessions();
        await refreshDetail();
    }
    tick();
    setInterval(tick, POLL_MS);
})();
