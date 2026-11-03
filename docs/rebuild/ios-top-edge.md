# The blur under the iPhone's status bar

Written down so nobody chases it again. Read from WebKit's main source and tested live on an iPhone (iOS 27.2, the installed
app, status-bar style `black`, build 5c8c87cf).

## What it is

The blur over the top of the installed app is **UIKit's soft scroll edge effect (the top scroll pocket) of the
WKWebView's scroll view**. It covers the status bar and roughly 40 pt below it, and it blurs and tints whatever the page has
there. It is not a `backdrop-filter`, a gradient or a shadow of ours: the page had none at the top on any tab (checked
element by element over the inspector).

## Why a page cannot switch it off

- `WKWebViewIOS.mm` `_shouldHideTopScrollPocket`: on iPhone the pocket is hidden only when a visible top colour extension view exists.
- `WKWebView.mm` `_updateFixedColorExtensionViews` creates one only if `_obscuredInsets.top > 0` **and** `LocalFrameView::fixedContainerEdges`
  found a fixed or sticky, full-width, opaque box more than 10 px deep at the midpoint of the top edge.
- `WebPage::sidesRequiringFixedContainerEdges` samples the top side only when `obscuredInsets.top > 0`.
- Live, after `Page.reload` with no user touch: `#status-edge` (fixed, 402 px wide, opaque) at 62 px, at 80 px, and with
  `pointer-events: auto`, still blurred every time. In the installed app with status-bar style `black` the top obscured inset is
  evidently 0 (the status bar is safe area, not an obscured inset), so WebKit never hides the pocket.

So no page change removes the effect. `#status-edge` stays: it is harmless, and it is what WebKit would use if a later iOS reports an obscured inset.

## What the page controls: what lies under it

Blurring a flat colour gives the same flat colour. It looked blurred because real content sat in the band: Settings' cards from
y = 64, Chat's transparent header over the thread, the KVM toolbar. So:

- the system's status area follows the page, one colour from the tab and the theme (`apps/web/src/app/status-colour.ts`:
  black over the KVM, the page colour on Chat and Settings), on `#status-edge`, html, body and the `theme-color` meta;
- the headers at the top are opaque in that colour (Chat's header has a background; Settings' title bar is sticky and solid;
  the KVM's stage is black), so content scrolls beneath them, never into the band as visible content;
- no `backdrop-filter`, blur or soft shadow anywhere near the top (`apps/web/e2e/phone-chrome.e2e.mjs` scans every element).

Header text and icons inside the band are still under the pocket and can look softened on the installed app; that is the
system's effect on them and is left as it is.

## Not the installed app

This only concerns the home-screen app. In a normal mobile browser tab (Safari, Firefox on iOS) the browser draws its own bars,
the page has no top safe-area inset, nothing above applies, and the layout is the plain one (`100dvh`, the visual viewport for
the keyboard, the navigation bar above the browser's toolbar). Nothing in the header change depends on standalone mode.
