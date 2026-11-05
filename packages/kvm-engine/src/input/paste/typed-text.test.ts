import { describe, expect, it } from "vitest";
import { FakeHttp } from "../../testing/fake-socket";
import type { Notice } from "../notice";
import { createTypingGate } from "../typing-gate";
import { createPaster } from "./paster";
import { MAX_RAW_CHARS, MAX_TYPED_CHARS, prepareTypedText } from "./typed-text";

// A clipboard holds whatever was copied. What is typed on the target is what a keyboard can type.

const typed = (input: string): string => prepareTypedText(input).text;

describe("line ends", () => {
    it("CRLF, CR and the Unicode line ends are one Enter each, never two", () => {
        expect(typed("a\r\nb\rc\nd\u2028e\u2029f\u0085g\u000bh\u000ci")).toBe("a\nb\nc\nd\ne\nf\ng\nh\ni");
        expect(typed("one\r\n\r\ntwo")).toBe("one\n\ntwo");
    });

    it("a tab stays a tab and a trailing newline stays (the text is typed as it is, not trimmed)", () => {
        expect(typed("\tindented\n")).toBe("\tindented\n");
        expect(typed("  spaces  ")).toBe("  spaces  ");
    });
});

describe("invisible and control characters", () => {
    it("zero-width, bidi, BOM, soft hyphen, word joiner and variation selectors vanish without a word", () => {
        const result = prepareTypedText("\ufeffa\u200bb\u200c\u200dc\u00ade\u2060f\u200e\u200fg\u202ah\u202ci\u2066j\u2069k\ufe0f");
        expect(result).toEqual({ text: "abcefghijk", folded: 0, dropped: 0, invisible: 13 });
    });

    it("NUL, BEL, ESC, DEL and the C1 block never reach the keyboard", () => {
        const result = prepareTypedText("a\u0000b\u0007c\u001bd\u007fe\u0080f\u009fg");
        expect(result.text).toBe("abcdefg");
        expect(result.invisible).toBe(6);
        expect(result.dropped).toBe(0);
    });

    it("a lone surrogate (a broken copy) is removed, a real pair is an emoji and is counted", () => {
        expect(prepareTypedText("a\ud83db").text).toBe("ab");
        expect(prepareTypedText("a\ude00b").text).toBe("ab");
        const emoji = prepareTypedText("hi \u{1f600}!");
        expect(emoji.text).toBe("hi !");
        expect(emoji.dropped).toBe(1);
    });
});

describe("spaces", () => {
    it("no-break and every other width of space type as a plain space", () => {
        expect(typed("a\u00a0b\u2003c\u2009d\u202fe\u3000f\u1680g\u205fh\u2007i")).toBe("a b c d e f g h i");
    });
});

describe("what a web page or a document brings", () => {
    it("curly quotes, dashes, the ellipsis and bullets are their plain equivalents, and counted", () => {
        const result = prepareTypedText("\u201cIt\u2019s fine\u201d \u2013 really\u2026 \u2022 ok \u2212 \u2018x\u2019");
        expect(result.text).toBe("\"It's fine\" - really... * ok - 'x'");
        expect(result.folded).toBe(9);
        expect(result.dropped).toBe(0);
    });

    it("ligatures from a PDF are letters again", () => {
        expect(typed("\ufb01rst \ufb02ow o\ufb00 o\ufb03ce \ufb04e")).toBe("first flow off office ffle");
    });

    it("full-width letters, digits and punctuation are ASCII", () => {
        expect(typed("\uff21\uff22\uff23 \uff11\uff12\uff13\uff01\uff1f")).toBe("ABC 123!?");
    });

    it("an accented letter sent as letter plus combining mark is the one character a keymap knows", () => {
        expect(typed("cafe\u0301 n\u0303")).toBe("caf\u00e9 \u00f1");
        expect(typed("cafe\u0301").length).toBe(4);
    });
});

describe("what a keyboard has no key for", () => {
    it("emoji, flags, ZWJ sequences, arrows, box drawing, dingbats and private use are left out, and counted once each", () => {
        const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
        const result = prepareTypedText(`a${family}b\u{1f1ec}\u{1f1e7}c\u2192d\u2502e\u2714f\ue000g`);
        expect(result.text).toBe("abcdefg");
        expect(result.dropped).toBe(3 + 2 + 1 + 1 + 1 + 1);
        expect(result.invisible).toBe(2);
    });

    it("an emoji with a skin tone or a variation selector is dropped, never half-typed", () => {
        const result = prepareTypedText("ok \u{1f44d}\u{1f3fd} \u2764\ufe0f");
        expect(result.text).toBe("ok  ");
        expect(result.dropped).toBe(3);
    });

    it("every script that is not emoji is kept for the chosen keymap to decide: accents, currency, Cyrillic, Greek, Hebrew, Arabic, CJK", () => {
        const kept = "\u00e9\u00fc\u00f1\u00df \u00a3\u20ac\u00a5 \u043f\u0440\u0438\u0432\u0435\u0442 \u03b1\u03b2\u03b3 \u05e9\u05dc\u05d5\u05dd \u0645\u0631\u062d\u0628\u0627 \u4f60\u597d \u3053\u3093\u306b\u3061\u306f";
        expect(prepareTypedText(kept)).toEqual({ text: kept, folded: 0, dropped: 0, invisible: 0 });
    });

    it("text of only untypable characters is nothing", () => {
        expect(typed("\u{1f600}\u{1f601}\u200b\u0000")).toBe("");
    });
});

describe("mixed rubbish, as a copy from a chat window or a spreadsheet gives it", () => {
    it("types the readable part, in order", () => {
        const input = "\ufeffName\tAmount\r\n\u201cAda\u201d\t\u00a312\u00a0000\u200b\r\nBob\t\u20ac9 \u{1f4b8}\r\n";
        expect(typed(input)).toBe('Name\tAmount\n"Ada"\t\u00a312 000\nBob\t\u20ac9 \n');
    });
});

describe("typing it", () => {
    function setup() {
        const http = new FakeHttp();
        const notices: Notice[] = [];
        const paster = createPaster({ http, gate: createTypingGate(), keymap: () => null, notify: (n) => notices.push(n), locale: "en-GB" });
        return { http, notices, paster };
    }

    it("what kvmd is sent is the cleaned text, and the result says how much was left out", async () => {
        const { http, notices, paster } = setup();
        const result = await paster.paste("a\r\n\u201cb\u201d \u{1f600}\u200b");
        expect(result).toEqual({ kind: "typed", chars: 6, dropped: 1, adjusted: 2 });
        expect(http.requests).toHaveLength(1);
        expect(http.requests[0]?.body).toBe('a\n"b" ');
        expect(notices[notices.length - 1]?.text).toBe(
            "Typed 6 characters on the target (2 characters were typed as plain ones; 1 character the keyboard cannot type was left out)",
        );
    });

    it("characters that were only adjusted (curly quotes, an em dash) are said too, so a pasted password or line of code that came out different is not a surprise", async () => {
        const { notices, paster } = setup();
        const result = await paster.paste("it\u2019s \u2014 ok");
        expect(result).toEqual({ kind: "typed", chars: 9, adjusted: 2 });
        expect(notices[notices.length - 1]?.text).toBe("Typed 9 characters on the target (2 characters were typed as plain ones)");
        notices.length = 0;
        await paster.paste("\u201cx");
        expect(notices[notices.length - 1]?.text).toBe("Typed 2 characters on the target (1 character was typed as a plain one)");
    });

    it("plain text is sent exactly as it is", async () => {
        const { http, paster } = setup();
        await paster.paste("echo 'hello' && ls -la\n");
        expect(http.requests[0]?.body).toBe("echo 'hello' && ls -la\n");
    });

    it("text with nothing a keyboard can type sends nothing and says so", async () => {
        const { http, notices, paster } = setup();
        expect(await paster.paste("\u{1f600}\u{1f680}")).toEqual({ kind: "nothing-typable" });
        expect(http.requests).toEqual([]);
        expect(notices).toEqual([{ text: "Nothing in that text can be typed on the target", error: true }]);
    });

    it("more than the most that can be typed at once is refused before anything is sent, and says how long it would take", async () => {
        const { http, notices, paster } = setup();
        expect(await paster.paste("x".repeat(MAX_TYPED_CHARS + 1))).toEqual({ kind: "too-long", chars: MAX_TYPED_CHARS + 1 });
        expect(http.requests).toEqual([]);
        expect(notices[0]?.error).toBe(true);
        expect(notices[0]?.text).toContain("100,001 characters");
        expect(notices[0]?.text).toContain("about 33 min");
        expect(await paster.paste("x".repeat(MAX_TYPED_CHARS))).toMatchObject({ kind: "typed" });
    });

    it("the size limit counts what is typed, not what was on the clipboard", async () => {
        const { http, paster } = setup();
        const noisy = "\u200b".repeat(500_000) + "ok";
        expect(await paster.paste(noisy)).toEqual({ kind: "typed", chars: 2 });
        expect(http.requests[0]?.body).toBe("ok");
    });

    it("a clipboard past MAX_RAW_CHARS is refused as it is, before it is scanned or copied", async () => {
        const { http, notices, paster } = setup();
        const huge = "a".repeat(MAX_RAW_CHARS + 1);
        expect(await paster.paste(huge)).toEqual({ kind: "too-long", chars: MAX_RAW_CHARS + 1 });
        expect(http.requests).toEqual([]);
        expect(notices).toEqual([{ text: "That is 2,000,001 characters, far more than can be typed at once (100,000).", error: true }]);
    });
});
