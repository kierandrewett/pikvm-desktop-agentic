/**
 * What is really typed on the target for a piece of text, which is whatever happened to be on the clipboard.
 *
 * kvmd types text one key at a time through a keymap, so it can only type what a keyboard can. A clipboard holds
 * much more: a web page or a document brings curly quotes, no-break spaces, zero-width marks, CRLF line ends, ligatures
 * from a PDF, full-width letters, emoji, a byte order mark, lone surrogates from a broken copy. Sent as they are, kvmd
 * skips what it has no key for without saying so, and a character that it half understands can type the wrong thing.
 * This turns the text into what the keyboard can type, and says how much it had to change:
 *
 *  - line ends of every kind become one newline (Enter); a tab stays a tab;
 *  - invisible and control characters go (zero-width, bidi marks, BOM, soft hyphen, NUL, ESC, DEL, the C1 block, lone
 *    surrogates, variation selectors): nothing a person sees, so nothing is reported;
 *  - spaces of every width become a plain space;
 *  - curly quotes, dashes, the ellipsis, bullets, ligatures and full-width ASCII become their plain equivalents
 *    (counted as `folded`);
 *  - characters no keymap has a key for, which are emoji and every other character above U+FFFF, arrows, boxes, dingbats
 *    and private-use characters, are left out (counted as `dropped`, and said, because a person sees them go);
 *  - everything else (letters and symbols of any script, accented letters, currency) is kept for the chosen keymap to
 *    decide: only kvmd knows the layout, and what it cannot type it skips.
 *
 * Text is put in NFC first, so an accented letter sent as a letter plus a combining mark is the one character a keymap
 * knows.
 */

/**
 * The most that is typed in one go. kvmd types at 20 ms a key and answers when it is done, so this is a little over half
 * an hour. More than that is almost certainly not meant (a file copied by mistake) and holds the target for hours.
 */
export const MAX_TYPED_CHARS = 100_000;

export interface TypedText {
    /** What kvmd is sent. */
    readonly text: string;
    /** Characters turned into a plain equivalent (a curly quote into a straight one). */
    readonly folded: number;
    /** Visible characters the keyboard has no key for, left out (emoji, arrows, symbols). One per character, not per code unit. */
    readonly dropped: number;
    /** Invisible and control characters removed. Not worth telling anyone, but the tests and the logs can count them. */
    readonly invisible: number;
}

/** Characters that become something else, one for one or many for one. */
const FOLD = new Map<number, string>([
    // single quotes and the prime
    [0x2018, "'"],
    [0x2019, "'"],
    [0x201a, "'"],
    [0x201b, "'"],
    [0x2032, "'"],
    // double quotes and the double prime
    [0x201c, '"'],
    [0x201d, '"'],
    [0x201e, '"'],
    [0x201f, '"'],
    [0x2033, '"'],
    // hyphens, dashes, the minus sign
    [0x2010, "-"],
    [0x2011, "-"],
    [0x2012, "-"],
    [0x2013, "-"],
    [0x2014, "-"],
    [0x2015, "-"],
    [0x2212, "-"],
    [0x2026, "..."],
    // bullets
    [0x2022, "*"],
    [0x2023, "*"],
    [0x25e6, "*"],
    [0x2219, "*"],
    // ligatures, from a PDF
    [0xfb00, "ff"],
    [0xfb01, "fi"],
    [0xfb02, "fl"],
    [0xfb03, "ffi"],
    [0xfb04, "ffl"],
    [0xfb05, "st"],
    [0xfb06, "st"],
]);

/** A line end of a kind that is not "\n": vertical tab, form feed, NEL, line and paragraph separator. */
const LINE_ENDS = new Set([0x0b, 0x0c, 0x85, 0x2028, 0x2029]);

/** Spaces of every width and the no-break space: a plain space. */
function isSpace(cp: number): boolean {
    return cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/** Format and invisible characters that a person never sees. */
function isInvisible(cp: number): boolean {
    return (
        cp === 0xad ||
        cp === 0x61c ||
        cp === 0x180e ||
        (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0x202a && cp <= 0x202e) ||
        (cp >= 0x2060 && cp <= 0x206f) ||
        (cp >= 0xfe00 && cp <= 0xfe0f) ||
        cp === 0xfeff ||
        (cp >= 0xfff9 && cp <= 0xfffb) ||
        (cp >= 0xe0000 && cp <= 0xe0fff)
    );
}

/** Control characters other than the tab and the newline, which are typed. DEL and the C1 block are included. */
function isControl(cp: number): boolean {
    return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f);
}

/** A lone surrogate: half of a pair, which is not a character. */
function isLoneSurrogate(cp: number): boolean {
    return cp >= 0xd800 && cp <= 0xdfff;
}

/** Visible characters that no keymap has a key for, below U+10000: arrows, technical and box symbols, dingbats, private use, the replacement character. */
function isUntypable(cp: number): boolean {
    return (
        cp > 0xffff ||
        (cp >= 0x2190 && cp <= 0x21ff) ||
        (cp >= 0x2200 && cp <= 0x22ff) ||
        (cp >= 0x2300 && cp <= 0x23ff) ||
        (cp >= 0x2460 && cp <= 0x24ff) ||
        (cp >= 0x2500 && cp <= 0x27bf) ||
        (cp >= 0x2b00 && cp <= 0x2bff) ||
        (cp >= 0xe000 && cp <= 0xf8ff) ||
        cp === 0xfffd ||
        cp === 0xfffe ||
        cp === 0xffff
    );
}

/** Full-width ASCII (U+FF01 to U+FF5E) is the same letters and punctuation as ASCII, 0xFEE0 higher. */
function fullWidthToAscii(cp: number): string | null {
    return cp >= 0xff01 && cp <= 0xff5e ? String.fromCodePoint(cp - 0xfee0) : null;
}

export function prepareTypedText(input: string): TypedText {
    // Line ends first, so CRLF is one Enter and not two.
    const text = input.normalize("NFC").replace(/\r\n?/g, "\n");
    let out = "";
    let folded = 0;
    let dropped = 0;
    let invisible = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (cp === 0x0a || cp === 0x09) {
            out += ch;
        } else if (LINE_ENDS.has(cp)) {
            out += "\n";
        } else if (isLoneSurrogate(cp) || isControl(cp) || isInvisible(cp)) {
            invisible += 1;
        } else if (isSpace(cp)) {
            out += " ";
        } else {
            const plain = FOLD.get(cp) ?? fullWidthToAscii(cp);
            if (plain !== null && plain !== undefined) {
                out += plain;
                folded += 1;
            } else if (isUntypable(cp)) {
                dropped += 1;
            } else {
                out += ch;
            }
        }
    }
    return { text: out, folded, dropped, invisible };
}
