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
        // Caps Lock is forwarded on its own, never inside a chord: the console keeps
        // the target's Caps Lock in step with the host's and resolves letter case
        // against the target's LED when each key is played (console.js drainKeys).
        if (code === "CapsLock" || key === "CapsLock") return { kind: "chord", mods: [], code: "CapsLock" };

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

    /**
     * Mirrors the modifiers the user is physically holding onto the target.
     *
     * The subtlety is not the tracking, it is the interaction with the two
     * paths that SYNTHESISE modifiers — chords and clicks. Both must stand down
     * for a key the user is already holding: pressing it again is harmless, but
     * releasing it at the end of a chord (or on pointerup) drops it while their
     * finger is still on the key, which is exactly the bug that made Ctrl+click
     * do nothing. `owned` answers "which of these are mine to press and
     * release", and is the only thing either path may act on.
     *
     * `send(code, down)` performs the actual HID write.
     */
    function createModifierMirror(send) {
        var held = Object.create(null);
        return {
            isHeld: function (code) {
                return held[code] === true;
            },
            press: function (code) {
                if (!code || held[code]) return false;
                held[code] = true;
                send(code, true);
                return true;
            },
            release: function (code) {
                if (!code || !held[code]) return false;
                delete held[code];
                send(code, false);
                return true;
            },
            releaseAll: function () {
                var codes = Object.keys(held);
                for (var i = 0; i < codes.length; i++) {
                    delete held[codes[i]];
                    send(codes[i], false);
                }
                return codes;
            },
            /** The subset a chord or click may press AND release itself. */
            owned: function (mods) {
                var out = [];
                for (var i = 0; i < (mods || []).length; i++) {
                    if (!held[mods[i]]) out.push(mods[i]);
                }
                return out;
            },
            /** Everything currently down, for assertions and diagnostics. */
            heldCodes: function () {
                return Object.keys(held);
            },
        };
    }

    return {
        decide: decide,
        chordMods: chordMods,
        createModifierMirror: createModifierMirror,
        CONTROL_KEYS: CONTROL_KEYS,
    };
});
