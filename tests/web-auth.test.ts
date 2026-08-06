import assert from "node:assert/strict";
import test from "node:test";
import { loginPage } from "../src/web-auth";

/** Just the markup. The <style> block carries an input[aria-invalid] rule in
 *  every variant, so a check for "no error wiring" has to look at the form. */
const form = (html: string): string => html.slice(html.indexOf("<body>"));

/**
 * A failed sign-in told a screen reader nothing.
 *
 * Getting the token wrong is a full round trip: POST, 302, and a fresh GET of
 * this page with ?error=1. The page then autofocuses the token field, so focus
 * lands in the input — and the only thing that said what had happened was a red
 * sentence AFTER the submit button, with no role, no live region and no link to
 * the field it was about. Measured over CDP before the fix:
 *
 *     errRole            null
 *     errLive            null
 *     errAfterButton     true
 *     inputInvalid       null
 *     inputDescribedBy   null
 *
 * So the one thing guaranteed to be read — the description of the control focus
 * just landed on — said nothing, and the message that did exist was somewhere
 * the reading order reaches last, if at all. Someone signing in from their phone
 * with VoiceOver on is told only that they are in a password field, again.
 *
 * The association is what fixes it, more than the role: aria-describedby on the
 * autofocused input means the text is read when focus arrives, which does not
 * depend on a screen reader choosing to announce an alert that was already in
 * the document at load. The alert role is the belt to that pair of braces.
 * After, the accessibility tree reads:
 *
 *     #t              textbox  "Access token"  desc "Wrong token. Try again."
 *                     invalid=true  describedby=signin-error
 *     #signin-error   alert    live=assertive  atomic=true
 */
test("a wrong token is announced on the field that was wrong", () => {
    const html = loginPage(true, false);
    assert.match(html, /aria-invalid="true" aria-describedby="signin-error"/);
    assert.match(html, /<div class="note err" id="signin-error" role="alert">Wrong token\. Try again\.<\/div>/);
    // Between the field and the button, so reading order matches the story:
    // label, field, what is wrong with it, what to do next.
    assert.ok(
        html.indexOf('id="signin-error"') < html.indexOf('<button type="submit">'),
        "the error must come before the submit button",
    );
    assert.ok(
        html.indexOf('id="t"') < html.indexOf('id="signin-error"'),
        "the error must come after the field it describes",
    );
});

/** Colour is not the only thing saying which field is wrong. */
test("the field in error is marked, not just coloured", () => {
    const html = loginPage(true, false);
    assert.match(html, /input\[aria-invalid="true"\]\{border-color:#f97583\}/);
    // The focus ring must not paint over it, or the marking vanishes exactly
    // when the user is on the field.
    assert.match(html, /input\[aria-invalid="true"\]:focus\{border-color:#f97583\}/);
});

/**
 * "Signed out." is a status, not an alert. It reports something the user
 * already asked for and nothing is wrong, so it should not interrupt.
 */
test("signing out reports politely and marks nothing invalid", () => {
    const html = loginPage(false, true);
    assert.match(html, /<div class="note ok" role="status">Signed out\.<\/div>/);
    assert.ok(!form(html).includes("aria-invalid"), "nothing is invalid after a sign-out");
    assert.ok(!form(html).includes('role="alert"'), "a sign-out must not interrupt");
});

/** The ordinary page carries none of it. */
test("a first visit has no error wiring at all", () => {
    const html = form(loginPage(false, false));
    assert.ok(!html.includes("aria-invalid"));
    assert.ok(!html.includes("aria-describedby"));
    assert.ok(!html.includes('role="alert"'));
    assert.ok(!html.includes('role="status"'));
    // Still the things that made it usable in the first place.
    assert.match(html, /<label for="t">Access token<\/label>/);
    assert.match(html, /autocomplete="current-password"/);
    assert.match(html, /autofocus/);
});

/** An error and a sign-out cannot both be shown; the error wins. */
test("an error after a sign-out shows only the error", () => {
    const html = loginPage(true, true);
    assert.match(html, /role="alert"/);
    assert.ok(!html.includes("Signed out."), "the stale sign-out note must not survive a failed retry");
});
