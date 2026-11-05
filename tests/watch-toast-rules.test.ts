/**
 * The text rules that turn what the OCR read off a pop-up into a notification. The OCR lines below are what PP-OCRv4 actually returned
 * on the fixtures of docs/e2e/2026-11-05-fast-alerts.md (Open Sans 12 to 14 px at 1080p, light and dark), including its habit of
 * running small words together and of reading the taskbar clock that is in the crop.
 *
 * Failure modes, before behaviour:
 *  T1. A call is notified as a message (or the reverse): wrong title, urgency or tag.
 *  T2. The caller's name is lost, or the app's name or a button is taken for it.
 *  T3. Furniture (Dismiss, Reply, a close glyph, the clock) reaches the notification, or counts as words.
 *  T4. Text that is not a pop-up's (a few glyphs) is notified.
 *  T5. The body is longer than a notification shows, or empty.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanLines, MAX_BODY_CHARS, MIN_TOAST_WORDS, readToast, toastForRule, toastHash } from "../src/server/watch/toast-rules";

const OUTLOOK = ["Outlook", "Anna Berg", "Lunch on Thursday?", "Areyoufree at12:30forthe quarterlyreview", "10:42", "11/05/2026"];
const TEAMS = ["Microsoft Teams", "Ben Carter", "Can you join the standup now?We are waiting", "10:42"];
const CALL = ["Microsoft Teams", "Priya Shah is calling you", "Accept", "Decline", "10:42"];
const UPDATE = ["Windows Update", "Updates are ready", "Restart now to finish installing the updates."];

describe("calls", () => {
    it("T1/T2: 'X is calling you' with Accept and Decline is a call from X, urgent, with a tag of the caller", () => {
        const toast = readToast(CALL)!;
        assert.equal(toast.kind, "call");
        assert.equal(toast.title, "Incoming call: Priya Shah");
        assert.equal(toast.who, "Priya Shah");
        assert.equal(toast.urgency, "high");
        assert.match(toast.tag, /^pikvm-call-[0-9a-f]{8}$/);
        assert.equal(toast.tag, readToast(["Microsoft Teams", "Priya Shah is calling you", "Accept", "Decline"])!.tag, "the same caller, the same tag");
        assert.notEqual(toast.tag, readToast(["Microsoft Teams", "Ben Carter is calling you", "Accept", "Decline"])!.tag);
        assert.ok(!/Accept|Decline|10:42/.test(toast.body));
    });

    it("T1: every way a toast says it is a call", () => {
        const lines = (...text: string[]) => ["Some App", ...text];
        for (const text of [
            ["Priya Shah is calling you", "Accept", "Decline"],
            ["Incoming call from Priya Shah"],
            ["Incoming video call", "Priya Shah"],
            ["Priya Shah wants to call you"],
            ["Priya Shah", "Ringing..."],
            ["Priya Shah", "Answer", "Reject"],
            ["Priya Shah", "Accept", "Ignore"],
        ]) {
            const toast = readToast(lines(...text));
            assert.equal(toast?.kind, "call", text.join(" / "));
            assert.equal(toast?.urgency, "high");
            assert.match(toast?.title ?? "", /^Incoming call/);
        }
    });

    it("T2: the caller is named by 'incoming call from', by 'wants to call', or else by the first line that looks like a name", () => {
        assert.equal(readToast(["Teams", "Incoming call from Priya Shah on Microsoft Teams"])!.who, "Priya Shah");
        assert.equal(readToast(["Teams", "Priya Shah wants to call you", "Accept", "Decline"])!.who, "Priya Shah");
        assert.equal(readToast(["Microsoft Teams", "Priya Shah", "Incoming call", "Accept", "Decline"])!.who, "Priya Shah");
        const nameless = readToast(["incoming call", "accept", "decline"])!;
        assert.equal(nameless.title, "Incoming call");
        assert.equal(nameless.who, undefined);
    });

    it("T1: a chat message that only mentions a call is a message", () => {
        const toast = readToast(["Microsoft Teams", "Ben Carter", "Please call me when you are free"])!;
        assert.equal(toast.kind, "teams");
        assert.equal(toast.urgency, "normal");
    });
});

describe("messages and mail", () => {
    it("a Teams message: the app is the title, the sender and the message the body", () => {
        const toast = readToast(TEAMS)!;
        assert.equal(toast.kind, "teams");
        assert.equal(toast.title, "Teams");
        assert.equal(toast.body, "Ben Carter: Can you join the standup now?We are waiting");
        assert.equal(toast.who, "Ben Carter");
        assert.equal(toast.urgency, "normal");
        assert.match(toast.tag, /^pikvm-alert-[0-9a-f]{8}$/);
    });

    it("an Outlook mail toast: sender, subject and the start of the message, without the taskbar clock and date", () => {
        const toast = readToast(OUTLOOK)!;
        assert.equal(toast.kind, "email");
        assert.equal(toast.title, "Outlook");
        assert.equal(toast.app, "Outlook");
        assert.equal(toast.body, "Anna Berg: Lunch on Thursday? - Areyoufree at12:30forthe quarterlyreview");
        assert.ok(!/10:42|2026/.test(toast.body));
    });

    it("mail is also known by its address, 'New mail' or 'From:'", () => {
        assert.equal(readToast(["New mail", "Anna Berg", "Lunch on Thursday?"])!.kind, "email");
        assert.equal(readToast(["anna.berg@example.org", "Lunch on Thursday?", "see you at noon"])!.kind, "email");
        assert.equal(readToast(["From: Anna Berg", "Subject: Lunch on Thursday"])!.kind, "email");
    });

    it("any other pop-up: its first line is the title, the rest the body", () => {
        const toast = readToast(UPDATE)!;
        assert.equal(toast.kind, "other");
        assert.equal(toast.title, "Windows Update");
        assert.equal(toast.body, "Updates are ready - Restart now to finish installing the updates.");
        assert.equal(toast.app, undefined);
    });

    it("a pop-up's tag is of its text: the same text the same tag, another text another", () => {
        assert.equal(readToast(TEAMS)!.tag, readToast([...TEAMS, "×"])!.tag);
        assert.notEqual(readToast(TEAMS)!.tag, readToast(OUTLOOK)!.tag);
    });

    it("what a rule is judged against is the app and the lines, on one line, at most 600 characters", () => {
        assert.equal(toastForRule(readToast(TEAMS)!), "Teams: Microsoft Teams | Ben Carter | Can you join the standup now?We are waiting");
        assert.ok(toastForRule(readToast(["Slack", "x".repeat(900), "more words here"])!).length <= 600);
    });
});

describe("furniture and too little text", () => {
    it("T3: buttons, close glyphs, clock times and dates are not text", () => {
        assert.deepEqual(cleanLines(["Teams", "Dismiss", "×", "Reply", "10:42", "10:42 PM", "11/05/2026", "  ", "Ben   Carter", "a", "…"]), ["Teams", "Ben Carter"]);
    });

    it("T4: fewer than three words is not a pop-up: nothing to say", () => {
        assert.equal(MIN_TOAST_WORDS, 3);
        assert.equal(readToast([]), null);
        assert.equal(readToast(["10:42", "11/05/2026"]), null);
        assert.equal(readToast(["Ping"]), null);
        assert.equal(readToast(["Slack", "Ping"]), null);
        assert.equal(readToast(["Slack", "Ping", "now!"])?.kind, "other");
    });

    it("T5: a body is at most 160 characters and ends in '...' when it was cut", () => {
        const long = readToast(["Outlook", "Anna Berg", "Subject " + "word ".repeat(80)])!;
        assert.equal(long.body.length, MAX_BODY_CHARS);
        assert.ok(long.body.endsWith("..."));
        assert.ok(long.title.length <= 60);
        const heading = readToast(["H".repeat(200) + " heading", "and the rest of it"])!;
        assert.ok(heading.title.length <= 60);
    });

    it("a toast with only an app line and one sender line still has a body", () => {
        const toast = readToast(["Microsoft Teams", "Ben Carter", "Hi"])!;
        assert.ok(toast.body.length > 0);
    });

    it("the same text is the same hash however it is spaced or capitalised", () => {
        assert.equal(toastHash("Teams Ben Carter: Hi."), toastHash("teams  ben carter hi"));
    });
});
