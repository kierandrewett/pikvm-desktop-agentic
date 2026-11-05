/**
 * Fast alerts' local diff: the same 128 x 72 grey grid, looked at inside one rectangle, and the words of what it sends.
 *
 * Failure modes, before behaviour:
 *  Z1. A caret, a clock digit or a pointer in the zone counts as a pop-up.
 *  Z2. A toast is dropped (below the zone threshold, or only noticed after the slow path's 6 s).
 *  Z3. A toast that goes away after it held is forgotten, or its going away is read as a second pop-up.
 *  Z4. A second toast over the first one is missed, or the first one fires again.
 *  Z5. The zone's cells are wrong (an off-by-one makes a toast at the edge invisible).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALERT_ZONES, alertZoneId } from "@pikvm/contracts/watch";
import { changedBox, createZoneSettler, zoneCells, zoneChangedFraction } from "../src/server/watch/frame-diff";
import { CELL_DELTA, DEFAULT_SETTLE_MS, ZONE_CHANGE_FRACTION } from "../src/server/watch/limits";
import { cursor, flat, patched } from "./support/watch-rig";

const BOTTOM_RIGHT = ALERT_ZONES[0].zone;
const cells = zoneCells(BOTTOM_RIGHT);
/** A toast-sized change inside the default zone: 24 x 9 cells, 13% of the zone. */
const toast = (base: Uint8Array, level = 240) => patched(base, 100, 45, 24, 9, level);
/** A second, different one above it. */
const toast2 = (base: Uint8Array) => patched(base, 100, 42, 24, 3, 20);

describe("the zone's cells", () => {
    it("Z5: the default zone is 49 x 33 cells of the corner, and every preset is inside the grid and not empty", () => {
        assert.deepEqual(cells, { x0: 79, y0: 39, x1: 128, y1: 72 });
        for (const preset of ALERT_ZONES) {
            const c = zoneCells(preset.zone);
            assert.ok(c.x0 >= 0 && c.y0 >= 0 && c.x1 <= 128 && c.y1 <= 72, preset.id);
            assert.ok(c.x1 - c.x0 >= 40 && c.y1 - c.y0 >= 25, `${preset.id} is a corner, not a sliver`);
        }
        assert.deepEqual(zoneCells({ x0: 0, y0: 0, x1: 0.38, y1: 0.45 }), { x0: 0, y0: 0, x1: 49, y1: 33 });
        assert.equal(alertZoneId(BOTTOM_RIGHT), "bottom-right");
        assert.equal(alertZoneId({ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 }), undefined);
    });

    it("a zone that is nothing, or lies outside the frame, still has at least one cell inside it", () => {
        const odd = zoneCells({ x0: 1, y0: 1, x1: 1, y1: 1 });
        assert.ok(odd.x1 > odd.x0 && odd.y1 > odd.y0 && odd.x1 <= 128 && odd.y1 <= 72);
    });

    it("counts only the zone: a change outside it is 0, a toast inside it is its own fraction of the zone", () => {
        const base = flat(60);
        assert.equal(zoneChangedFraction(base, patched(base, 20, 10, 16, 8, 240), cells), 0);
        assert.equal(zoneChangedFraction(base, toast(base), cells), (24 * 9) / (49 * 33));
        assert.equal(zoneChangedFraction(base, flat(60 + CELL_DELTA - 1), cells), 0);
        assert.equal(zoneChangedFraction(new Uint8Array(10), new Uint8Array(20), cells), 1);
    });
});

describe("the zone settler", () => {
    const make = () => createZoneSettler({ settleMs: DEFAULT_SETTLE_MS, changeFraction: ZONE_CHANGE_FRACTION });

    it("Z1: a caret, a clock digit and a pointer in the zone never leave idle, however long they go on", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        let t = 1000;
        for (let i = 0; i < 60; i++, t += 1000) {
            const noisy = patched(base, 100, 50 + (i % 5), 1, 2, 255);
            assert.equal(settler.look(i % 2 ? cursor(base) : noisy, cells, t).state, "idle");
        }
        assert.ok(zoneChangedFraction(base, patched(base, 100, 50, 1, 2, 255), cells) < ZONE_CHANGE_FRACTION);
    });

    it("Z2: a toast holding for the settle time has appeared, and the look that says so carries its first sighting", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        assert.equal(settler.look(toast(base), cells, 1000).state, "changing");
        assert.equal(settler.wakeAt, 1000 + DEFAULT_SETTLE_MS, "an extra look is due when it will have held long enough");
        assert.equal(settler.look(toast(base), cells, 1000 + DEFAULT_SETTLE_MS - 1).state, "changing");
        const seen = settler.look(toast(base), cells, 1000 + DEFAULT_SETTLE_MS);
        assert.equal(seen.state, "appeared");
        if (seen.state !== "appeared") return;
        assert.equal(seen.firstSeenAt, 1000);
        assert.equal(seen.source, "confirmed");
        assert.equal(seen.quiet.join(), base.join(), "and the zone as it was before, to say what changed");
        assert.ok(seen.score > 0.1);
        assert.equal(settler.wakeAt, null);
    });

    it("a toast still sliding in (changing between looks) holds from its last change, not its first", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        settler.look(patched(base, 100, 45, 24, 4, 240), cells, 1000); // half way in
        assert.equal(settler.look(toast(base), cells, 2000).state, "changing");
        assert.equal(settler.wakeAt, 2000 + DEFAULT_SETTLE_MS);
        assert.equal(settler.look(toast(base), cells, 2000 + DEFAULT_SETTLE_MS).state, "appeared");
    });

    it("a flash that is gone before it held is not a pop-up", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        assert.equal(settler.look(toast(base), cells, 1000).state, "changing");
        assert.equal(settler.look(base, cells, 1500).state, "reverted");
        assert.equal(settler.wakeAt, null);
        assert.equal(settler.look(base, cells, 9000).state, "idle");
    });

    it("a toast that is gone at the confirming look (it was there at the look before) still counts, and is read from the look that saw it", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        settler.look(toast(base), cells, 1000);
        const seen = settler.look(base, cells, 1000 + DEFAULT_SETTLE_MS);
        assert.equal(seen.state, "appeared");
        if (seen.state !== "appeared") return;
        assert.equal(seen.source, "detected");
        assert.equal(seen.grid.join(), toast(base).join(), "the grid of the toast, not of the desktop that is there now");
        assert.equal(seen.firstSeenAt, 1000);
        assert.ok(seen.score > 0.1);
        // And the zone is quiet again: the toast going is not a second pop-up.
        assert.equal(settler.look(base, cells, 9000).state, "idle");
        assert.equal(settler.wakeAt, null);
    });

    it("a toast gone before the settle time is a flash even if it was there at every look before", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        settler.look(toast(base), cells, 1000);
        assert.equal(settler.look(base, cells, 1000 + DEFAULT_SETTLE_MS - 200).state, "reverted");
    });

    it("the changed box is the changed cells and a margin, inside the zone, and the whole zone when nothing changed", () => {
        const base = flat(60);
        assert.deepEqual(changedBox(base, toast(base), cells, 2), { x0: 98, y0: 43, x1: 126, y1: 56 });
        assert.deepEqual(changedBox(base, patched(base, 79, 39, 3, 3, 240), cells, 2), { x0: 79, y0: 39, x1: 84, y1: 44 }, "kept inside the zone");
        assert.deepEqual(changedBox(base, base, cells, 2), cells);
        assert.deepEqual(changedBox(base, patched(base, 10, 10, 5, 5, 240), cells, 2), cells, "a change outside the zone is not in the box");
        assert.deepEqual(changedBox(new Uint8Array(4), new Uint8Array(4), cells, 2), cells);
    });

    it("Z3: after it appeared, going away is not undone and not a second pop-up; the next toast is a new one", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        settler.look(toast(base), cells, 1000);
        assert.equal(settler.look(toast(base), cells, 2200).state, "appeared");
        // It stays up for seconds: nothing more fires.
        for (let t = 3200; t < 7000; t += 1000) assert.equal(settler.look(toast(base), cells, t).state, "idle");
        // It goes: back to what was there, quietly, for as long as it likes.
        for (let t = 7200; t < 20_000; t += 1000) assert.equal(settler.look(base, cells, t).state, "idle");
        settler.look(toast(base), cells, 21_000);
        assert.equal(settler.look(toast(base), cells, 22_200).state, "appeared");
    });

    it("Z4: a second toast over the first one appears on its own, and the first does not fire again when it goes", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        settler.look(toast(base), cells, 1000);
        assert.equal(settler.look(toast(base), cells, 2200).state, "appeared");
        settler.look(toast2(toast(base)), cells, 3200);
        assert.equal(settler.look(toast2(toast(base)), cells, 4400).state, "appeared");
        // Both gone at once: quiet.
        assert.equal(settler.look(base, cells, 5400).state, "idle");
        assert.equal(settler.look(base, cells, 6400).state, "idle");
    });

    it("a toast that is dismissed while the desktop behind it changed is read as a new change, not silently dropped", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        settler.look(toast(base), cells, 1000);
        settler.look(toast(base), cells, 2200);
        const behind = patched(base, 90, 40, 30, 20, 150);
        assert.equal(settler.look(behind, cells, 3200).state, "changing");
        assert.equal(settler.look(behind, cells, 4400).state, "appeared");
    });

    it("slow drift under the threshold is followed, so only a jump between looks counts", () => {
        const settler = make();
        let grid = flat(60);
        settler.look(grid, cells, 0);
        for (let i = 1; i <= 30; i++) {
            grid = patched(grid, 79 + (i % 40), 40, 1, 1, 60 + (i % 2 ? 40 : 0));
            assert.equal(settler.look(grid, cells, i * 1000).state, "idle");
        }
    });

    it("reset forgets the quiet zone: the next look is adopted, not compared", () => {
        const settler = make();
        const base = flat(60);
        settler.look(base, cells, 0);
        settler.look(toast(base), cells, 1000);
        settler.reset();
        assert.equal(settler.wakeAt, null);
        assert.equal(settler.look(toast(base), cells, 2000).state, "idle");
    });
});
