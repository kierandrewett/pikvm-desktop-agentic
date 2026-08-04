/**
 * Keyboard chord decisions for the KVM console.
 *
 * Pure: takes a KeyboardEvent-shaped object plus the armed sticky modifiers, and
 * returns what the target should receive. It lives outside console.js (2500 lines of
 * browser script with no test hook) because this is the part that has to be exactly
 * right. A dropped modifier here is not a missing keystroke, it is a DIFFERENT one:
 * Shift+Enter arriving as Enter sends the message instead of breaking the line, and
 * Ctrl+Shift+Esc arriving as Ctrl+Esc opens the Start menu instead of Task Manager.
 *
 * Loaded as a plain script in the browser (window.KeyChord) and required directly by
 * the Node tests.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.KeyChord = api;
})(typeof self !== "undefined" ? self : this, function () {
    /** Named keys we forward by code rather than by produced character. */
    var CONTROL_KEYS = {
        Enter: "Enter",
        Backspace: "Backspace",
        Tab: "Tab",
        Escape: "Escape",
        Delete: "Delete",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
        ArrowUp: "ArrowUp",
        ArrowDown: "ArrowDown",
        ArrowLeft: "ArrowLeft",
        ArrowRight: "ArrowRight",
    };

    var BARE_MODIFIER = /^(Control|Alt|Meta|Shift)(Left|Right)?$/;

    function hasShift(mods) {
        return mods.indexOf("ShiftLeft") >= 0 || mods.indexOf("ShiftRight") >= 0;
    }

    /**
     * Every modifier that should be held for this chord: the ones physically down on
     * the host, plus any sticky on-screen modifiers the user armed. Shift is resolved
     * HERE rather than left to each call site — passing it separately is what let the
     * control-key path drop it silently.
     */
    function chordMods(ev, armed) {
        var m = [];
        if (ev.ctrlKey) m.push("ControlLeft");
        if (ev.altKey) m.push("AltLeft");
        if (ev.metaKey) m.push("MetaLeft");
        var list = armed || [];
        for (var i = 0; i < list.length; i++) if (m.indexOf(list[i]) < 0) m.push(list[i]);
        if (ev.shiftKey && !hasShift(m)) m.push("ShiftLeft");
        return m;
    }

    /**
     * What to send for a keydown.
     *
     * Returns one of:
     *   {kind:"chord", mods, code}  send these modifiers held around this key
     *   {kind:"char",  char}        a printable character (case resolved by the layout)
     *   {kind:"swallow", why}       consume the event, send nothing
     *   {kind:"ignore",  why}       not ours, leave the event alone
     *
     * `opts.printable` is false for the hidden-input path, where the browser's
     * beforeinput event (and the soft keyboard) produces characters instead.
     */
    function decide(ev, opts) {
        var o = opts || {};
        var code = ev.code || "";
        var key = ev.key || "";
        if (ev.isComposing) return { kind: "ignore", why: "composing" };
        if (BARE_MODIFIER.test(code)) return { kind: "ignore", why: "bare-modifier" };
        // Caps Lock is never forwarded: we hold the target's caps OFF and derive letter
        // case from the host's e.key, which is synchronous and cannot race the LED.
        if (code === "CapsLock" || key === "CapsLock") return { kind: "swallow", why: "caps-held-off" };

        var mods = chordMods(ev, o.armed);
        var ctl = CONTROL_KEYS[code] || CONTROL_KEYS[key] || (/^F\d{1,2}$/.test(code) ? code : null);
        if (ctl) return { kind: "chord", mods: mods, code: ctl };

        // A hardware chord (Ctrl+C, Ctrl+Shift+T). Shift alone does NOT land here —
        // it belongs to the printable path, where the layout map resolves the glyph.
        if (ev.ctrlKey || ev.altKey || ev.metaKey) {
            if (!code) return { kind: "ignore", why: "no-code" };
            return { kind: "chord", mods: mods, code: code };
        }

        if (!o.printable) return { kind: "ignore", why: "printable-handled-elsewhere" };
        if (key.length === 1) return { kind: "char", char: key };
        // A named key we have no mapping for (Insert, PrintScreen, media keys).
        if (code) return { kind: "chord", mods: mods, code: code };
        return { kind: "ignore", why: "no-code" };
    }

    return { decide: decide, chordMods: chordMods, CONTROL_KEYS: CONTROL_KEYS };
});
