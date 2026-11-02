/** The kvmd message schemas against frames the console really sends and receives. */

import { decodeKvmdFrame, HidCommand, isRelease, SettingsPatch } from "@pikvm/contracts";
import { Schema } from "effect";
import assert from "node:assert/strict";
import test from "node:test";

const decodeCommand = Schema.decodeUnknownEither(HidCommand);

test("the HID commands the console sends decode", () => {
    const frames: unknown[] = [
        { event_type: "key", event: { key: "KeyA", state: true } },
        { event_type: "mouse_move", event: { to: { x: -32768, y: 32767 } } },
        { event_type: "mouse_button", event: { button: "left", state: false } },
        { event_type: "mouse_wheel", event: { delta: { x: 0, y: -1 } } },
        { event_type: "mouse_relative", event: { delta: { x: 127, y: -127 }, squash: true } },
        { event_type: "ping", event: {} },
    ];
    for (const frame of frames) assert.equal(decodeCommand(frame)._tag, "Right", JSON.stringify(frame));
});

test("commands kvmd would not take are refused before they are sent", () => {
    const frames: unknown[] = [
        { event_type: "key", event: { key: "Not a key", state: true } },
        { event_type: "key", event: { key: "KeyA" } },
        { event_type: "mouse_move", event: { to: { x: 40000, y: 0 } } },
        { event_type: "mouse_move", event: { to: { x: 0.5, y: 0 } } },
        { event_type: "mouse_relative", event: { delta: { x: 128, y: 0 }, squash: true } },
        { event_type: "mouse_button", event: { button: "back", state: true } },
        { event_type: "reboot", event: {} },
    ];
    for (const frame of frames) assert.equal(decodeCommand(frame)._tag, "Left", JSON.stringify(frame));
});

test("only releases survive the stale-queue cutoff", () => {
    const decode = Schema.decodeUnknownSync(HidCommand);
    assert.equal(isRelease(decode({ event_type: "key", event: { key: "KeyA", state: false } })), true);
    assert.equal(isRelease(decode({ event_type: "mouse_button", event: { button: "left", state: false } })), true);
    assert.equal(isRelease(decode({ event_type: "key", event: { key: "KeyA", state: true } })), false);
    assert.equal(isRelease(decode({ event_type: "mouse_move", event: { to: { x: 0, y: 0 } } })), false);
});

test("state events decode as partial deltas, in either LED shape", () => {
    const hid = decodeKvmdFrame(
        JSON.stringify({
            event_type: "hid",
            event: { keyboard: { online: true, leds: { caps: true } }, mouse: { absolute: false, outputs: { available: ["usb", "usb_rel"], active: "usb_rel" } } },
        }),
    );
    assert.equal(hid?.event_type, "hid");
    if (hid?.event_type === "hid") {
        assert.equal(hid.event.keyboard?.leds?.caps, true);
        assert.equal(hid.event.mouse?.absolute, false);
        assert.equal(hid.event.online, undefined, "fields kvmd did not send stay absent");
    }

    const old = decodeKvmdFrame(JSON.stringify({ event_type: "hid", event: { leds: { caps: false } } }));
    assert.ok(old && old.event_type === "hid" && old.event.leds?.caps === false);

    const keymaps = decodeKvmdFrame(
        JSON.stringify({ event_type: "hid_keymaps", event: { keymaps: { default: "en-us", available: ["en-us", "en-gb"] } } }),
    );
    assert.ok(keymaps && keymaps.event_type === "hid_keymaps" && keymaps.event.keymaps?.available?.length === 2);

    // kvmd itself sends the available keymaps as a map of name -> details.
    const real = decodeKvmdFrame(
        JSON.stringify({ event_type: "hid_keymaps", event: { keymaps: { default: "en-us", available: { "en-us": {}, "en-gb": {}, de: {} } } } }),
    );
    assert.ok(real && real.event_type === "hid_keymaps");
    assert.deepEqual(Object.keys(real.event.keymaps?.available ?? {}).sort(), ["de", "en-gb", "en-us"]);

    assert.equal(decodeKvmdFrame('{"event_type":"pong","event":{}}')?.event_type, "pong");
});

test("a frame the app does not model, or garbage, is skipped without throwing", () => {
    assert.equal(decodeKvmdFrame('{"event_type":"switch","event":{"x":1}}'), null);
    assert.equal(decodeKvmdFrame("not json"), null);
    assert.equal(decodeKvmdFrame('{"event_type":"hid","event":{"online":"yes"}}'), null);
});

test("a settings patch names its fields and nothing else", () => {
    const decode = Schema.decodeUnknownEither(SettingsPatch);
    assert.equal(decode({ jiggler: true })._tag, "Right");
    assert.equal(decode({})._tag, "Right");
    assert.equal(decode({ accessToken: "x" })._tag, "Left");
});
