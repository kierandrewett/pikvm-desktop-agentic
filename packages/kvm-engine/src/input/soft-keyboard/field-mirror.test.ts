import { describe, expect, it } from "vitest";
import { createFieldMirror, diffField, KB_MAX, KB_PAD, type FieldPort, type MirrorSink } from "./field-mirror";

// Failure modes 1-12 in FAILURE_MODES.md.

const typable = (ch: string): boolean => /^[\x20-\x7e]$/.test(ch);

class FakeField implements FieldPort {
    value = "";
    writes: string[] = [];
    read(): string {
        return this.value;
    }
    write(value: string): void {
        this.value = value;
        this.writes.push(value);
    }
}

class Recorder implements MirrorSink {
    readonly log: string[] = [];
    canType = typable;
    sendBackspace(): void {
        this.log.push("<BS>");
    }
    sendNewline(): void {
        this.log.push("<NL>");
    }
    sendChar(ch: string): void {
        // Like the keyboard, characters with no key are dropped on the way out.
        if (this.canType(ch)) this.log.push(ch);
    }
    text(): string {
        return this.log.join("");
    }
}

function setup() {
    const field = new FakeField();
    const sink = new Recorder();
    const mirror = createFieldMirror(field, sink);
    mirror.reset();
    sink.log.length = 0;
    field.writes.length = 0;
    /** The user (or IME) changes the field, then the browser fires `input`. */
    const edit = (value: string, composing = false): void => {
        field.value = value;
        mirror.input(composing);
    };
    return { field, sink, mirror, edit };
}

describe("diffField", () => {
    it("is null when nothing changed", () => {
        expect(diffField("abc", "abc", typable)).toBeNull();
        expect(diffField(KB_PAD, KB_PAD, typable)).toBeNull();
    });

    it("types appended characters", () => {
        expect(diffField(KB_PAD, `${KB_PAD}hi`, typable)).toEqual({
            actions: [
                { type: "char", char: "h" },
                { type: "char", char: "i" },
            ],
            synced: `${KB_PAD}hi`,
        });
    });

    it("backs up to the first difference, then retypes the rest", () => {
        const diff = diffField("hello wrld", "hello world", typable);
        expect(diff?.actions).toEqual([
            ...Array.from("rld").map(() => ({ type: "backspace" as const })),
            ...Array.from("orld").map((char) => ({ type: "char" as const, char })),
        ]);
    });

    it("counts code points, not UTF-16 units, so an emoji is one character", () => {
        const diff = diffField("a\u{1F600}", "a", (ch) => ch === "a");
        // The emoji was never typed (no key for it), so deleting it sends no Backspace.
        expect(diff?.actions).toEqual([]);
        expect(diff?.synced).toBe("a");
    });
});

describe("typing", () => {
    it("replays each character the field gains, once", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}h`);
        edit(`${KB_PAD}he`);
        edit(`${KB_PAD}hey`);
        expect(sink.text()).toBe("hey");
    });

    it("a phrase dropped in by dictation is typed in order", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}hello world`);
        expect(sink.text()).toBe("hello world");
    });

    it("an input event that changes nothing sends nothing", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}a`);
        sink.log.length = 0;
        edit(`${KB_PAD}a`);
        expect(sink.log).toEqual([]);
    });

    it("a rewrite mid-word (dictation correcting itself) backs up and retypes", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}hello wrld`);
        sink.log.length = 0;
        edit(`${KB_PAD}hello world`);
        expect(sink.text()).toBe("<BS><BS><BS>orld");
    });

    it("a swipe-typing suggestion swap replaces the word", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}teh`);
        sink.log.length = 0;
        edit(`${KB_PAD}the`);
        expect(sink.text()).toBe("<BS><BS>he");
    });

    it("a newline becomes Enter", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}ab\ncd`);
        expect(sink.text()).toBe("ab<NL>cd");
    });

    it("characters the layout cannot type are never sent, and deleting them sends no Backspace", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}a\u00e9b`);
        expect(sink.text()).toBe("ab");
        sink.log.length = 0;
        edit(`${KB_PAD}a\u00e9`);
        expect(sink.text()).toBe("<BS>");
        sink.log.length = 0;
        edit(`${KB_PAD}a`);
        expect(sink.text()).toBe("");
    });
});

describe("the pad (failure mode 2)", () => {
    it("starts the field at the pad", () => {
        const field = new FakeField();
        createFieldMirror(field, new Recorder()).reset();
        expect(field.value).toBe(KB_PAD);
    });

    it("a Backspace on an 'empty' field still changes it and still reaches the target", () => {
        const { sink, edit } = setup();
        edit(KB_PAD.slice(0, -1));
        expect(sink.text()).toBe("<BS>");
    });

    it("pad characters are never typed", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}\u200bx`);
        expect(sink.text()).toBe("x");
    });

    it("reset does not rewrite a field that already holds the pad", () => {
        const { field, mirror } = setup();
        mirror.reset();
        expect(field.writes).toEqual([]);
    });

    it("after a reset the diff starts from the pad, so typing continues cleanly", () => {
        const { field, sink, mirror, edit } = setup();
        edit(`${KB_PAD}abc`);
        sink.log.length = 0;
        mirror.reset(); // the target's caret moved (an arrow key)
        expect(field.value).toBe(KB_PAD);
        edit(`${KB_PAD}d`);
        expect(sink.text()).toBe("d");
    });
});

describe("dictation placeholder (failure mode 3)", () => {
    it("U+FFFC is stripped: the listening placeholder types nothing", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}\uFFFC`);
        expect(sink.log).toEqual([]);
    });

    it("and replaced cleanly by the recognised text", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}\uFFFC`);
        edit(`${KB_PAD}hello`);
        expect(sink.text()).toBe("hello");
    });

    it("a placeholder appearing after text does not retype that text", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}hi`);
        sink.log.length = 0;
        edit(`${KB_PAD}hi\uFFFC`);
        expect(sink.log).toEqual([]);
    });
});

describe("typographic folding (failure mode 4)", () => {
    it.each([
        ["\u2019", "'"],
        ["\u2018", "'"],
        ["\u201c", '"'],
        ["\u201d", '"'],
        ["\u2013", "-"],
        ["\u2014", "--"],
        ["\u2026", "..."],
        ["\u00a0", " "],
    ])("%j is typed as %j", (fancy, plain) => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}${fancy}`);
        expect(sink.text()).toBe(plain);
    });

    it("deleting a folded character sends as many Backspaces as it typed", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}\u2014`);
        sink.log.length = 0;
        edit(KB_PAD);
        expect(sink.text()).toBe("<BS><BS>");
        edit(`${KB_PAD}\u2026`);
        sink.log.length = 0;
        edit(KB_PAD);
        expect(sink.text()).toBe("<BS><BS><BS>");
    });

    it("an iPhone 'don\u2019t' reaches the target with its apostrophe", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}don\u2019t`);
        expect(sink.text()).toBe("don't");
    });
});

describe("composition (failure mode 7)", () => {
    it("settle never replaces the value under an IME", () => {
        const { field, mirror, edit } = setup();
        mirror.compositionStart();
        // The pad was eaten into while composing.
        edit("x", true);
        expect(field.value).toBe("x");
        mirror.compositionEnd();
        // After the word is committed the field is brought back to the pad.
        expect(field.value).toBe(KB_PAD);
    });

    it("input events flagged isComposing mark composition even without compositionstart", () => {
        const { field, mirror } = setup();
        field.value = "y";
        mirror.input(true);
        expect(mirror.isComposing()).toBe(true);
        expect(field.value).toBe("y");
    });

    it("compositionend replays the committed text", () => {
        const { sink, field, mirror } = setup();
        mirror.compositionStart();
        field.value = `${KB_PAD}hello`;
        mirror.input(true);
        mirror.compositionEnd();
        expect(sink.text()).toBe("hello");
    });

    it("blur ends a composition and clears the field", () => {
        const { field, mirror, edit } = setup();
        mirror.compositionStart();
        edit(`${KB_PAD}abc`, true);
        mirror.blur();
        expect(mirror.isComposing()).toBe(false);
        expect(field.value).toBe(KB_PAD);
    });
});

describe("settling (failure mode 8)", () => {
    it("restores the pad when the pad was eaten into", () => {
        const { field, edit } = setup();
        edit(KB_PAD.slice(0, 2));
        expect(field.value).toBe(KB_PAD);
    });

    it("starts a fresh buffer past 96 characters at a word boundary", () => {
        const { field, edit } = setup();
        edit(`${KB_PAD}${"a".repeat(KB_MAX)} `);
        expect(field.value).toBe(KB_PAD);
    });

    it("but never mid-word", () => {
        const { field, edit } = setup();
        const long = `${KB_PAD}${"a".repeat(KB_MAX)}`;
        edit(long);
        expect(field.value).toBe(long);
    });

    it("a reset that lands after typing makes the next diff start from the pad", () => {
        const { sink, edit } = setup();
        edit(`${KB_PAD}${"a".repeat(KB_MAX)} `);
        sink.log.length = 0;
        edit(`${KB_PAD}b`);
        expect(sink.text()).toBe("b");
    });
});

describe("blocked input (failure mode 9)", () => {
    it("is discarded rather than replayed", () => {
        const { field, sink, mirror } = setup();
        field.value = `${KB_PAD}secret`;
        mirror.input(false, true);
        expect(sink.log).toEqual([]);
        expect(field.value).toBe(KB_PAD);
    });
});
