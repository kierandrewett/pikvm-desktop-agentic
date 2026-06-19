// Mobile touch pan/zoom for the proxied PiKVM stream.
//
// Convention (resolves the input-vs-pan ambiguity on a touchscreen):
//   - one finger  -> passes through to PiKVM untouched (cursor move / tap = click)
//   - two fingers -> pinch to zoom, drag to pan the VIEW (never sent as input)
//   - double tap  -> reset to fit
//
// We apply a CSS transform to the stream element itself. PiKVM maps input via the
// element's getBoundingClientRect(), which reflects the transform, so one-finger
// input still lands on the right remote pixel while zoomed. Served at
// /_agent/touch.js and injected into proxied pages.
//
// Needs on-device validation (gesture feel + that PiKVM's input mapping really is
// rect-relative on the target firmware). Self-contained so it is easy to tweak.

(function () {
    "use strict";
    if (window.top !== window.self) return; // not inside the agent iframe

    var MIN = 1;
    var MAX = 6;
    var el = null;
    var scale = 1;
    var tx = 0;
    var ty = 0;
    var pts = new Map(); // pointerId -> {x, y}
    var engaged = false;
    var prevDist = 0;
    var prevCx = 0;
    var prevCy = 0;
    var lastTap = 0;

    function findStream() {
        return document.querySelector("#stream-image, #stream-video, #stream-canvas");
    }

    function apply() {
        if (!el) return;
        el.style.transformOrigin = "0 0";
        el.style.transform = "translate(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px) scale(" + scale.toFixed(4) + ")";
        el.style.willChange = scale > 1 ? "transform" : "auto";
    }

    function reset() {
        scale = 1;
        tx = 0;
        ty = 0;
        apply();
    }

    // Keep the content from being panned completely off-screen.
    function clampPan() {
        if (!el) return;
        var origin = { x: el.getBoundingClientRect().left - tx, y: el.getBoundingClientRect().top - ty };
        var w = el.offsetWidth * scale;
        var h = el.offsetHeight * scale;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        // Allow a little overscroll but keep at least a slice visible.
        var minX = vw - origin.x - w;
        var maxX = -origin.x;
        var minY = vh - origin.y - h;
        var maxY = -origin.y;
        if (w > vw) tx = Math.min(maxX, Math.max(minX, tx));
        else tx = Math.max(minX, Math.min(maxX, tx));
        if (h > vh) ty = Math.min(maxY, Math.max(minY, ty));
        else ty = Math.max(minY, Math.min(maxY, ty));
    }

    function centroid() {
        var sx = 0;
        var sy = 0;
        pts.forEach(function (p) {
            sx += p.x;
            sy += p.y;
        });
        var n = pts.size;
        return { x: sx / n, y: sy / n };
    }

    function distance() {
        var arr = Array.from(pts.values());
        var dx = arr[0].x - arr[1].x;
        var dy = arr[0].y - arr[1].y;
        return Math.hypot(dx, dy);
    }

    function onDown(e) {
        if (e.pointerType !== "touch") return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 2) {
            engaged = true;
            prevDist = distance();
            var c = centroid();
            prevCx = c.x;
            prevCy = c.y;
        }
    }

    function onMove(e) {
        if (!engaged) return;
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size < 2) return;
        e.preventDefault();
        e.stopPropagation();

        var c = centroid();
        var d = distance();
        var f = prevDist > 0 ? d / prevDist : 1;
        var newScale = Math.min(MAX, Math.max(MIN, scale * f));

        // Zoom around the pinch centroid, then add the centroid's own pan.
        var rect = el.getBoundingClientRect();
        var ox = rect.left - tx;
        var oy = rect.top - ty;
        var ratio = newScale / scale;
        tx = prevCx - ox - ratio * (prevCx - ox - tx) + (c.x - prevCx);
        ty = prevCy - oy - ratio * (prevCy - oy - ty) + (c.y - prevCy);
        scale = newScale;

        prevDist = d;
        prevCx = c.x;
        prevCy = c.y;
        clampPan();
        apply();
    }

    function onUp(e) {
        if (pts.has(e.pointerId)) pts.delete(e.pointerId);
        if (pts.size < 2) {
            engaged = false;
            // Double-tap (two quick single-finger taps) resets the view.
            if (e.pointerType === "touch" && pts.size === 0) {
                var now = Date.now();
                if (now - lastTap < 300) reset();
                lastTap = now;
            }
        }
    }

    // Desktop browsers: ctrl/cmd + wheel zooms; plain wheel stays as PiKVM scroll.
    function onWheel(e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        e.stopPropagation();
        var rect = el.getBoundingClientRect();
        var ox = rect.left - tx;
        var oy = rect.top - ty;
        var f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        var newScale = Math.min(MAX, Math.max(MIN, scale * f));
        var ratio = newScale / scale;
        tx = e.clientX - ox - ratio * (e.clientX - ox - tx);
        ty = e.clientY - oy - ratio * (e.clientY - oy - ty);
        scale = newScale;
        clampPan();
        apply();
    }

    function attach(target) {
        el = target;
        // Capture phase so two-finger gestures are handled before PiKVM's own
        // listeners; one-finger events fall straight through to it.
        el.addEventListener("pointerdown", onDown, true);
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onUp, true);
        el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    }

    // The stream element appears asynchronously; wait for it.
    var tries = 0;
    var timer = setInterval(function () {
        var s = findStream();
        if (s) {
            clearInterval(timer);
            attach(s);
        } else if (++tries > 100) {
            clearInterval(timer);
        }
    }, 200);
})();
