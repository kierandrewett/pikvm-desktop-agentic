---
name: PiKVM Desktop
description: A quiet operator workspace for visible, verifiable computer use.
colors:
  operator-black: "#0A0A0C"
  workspace-charcoal: "#121216"
  quiet-control: "#1A1A20"
  active-surface: "#23232B"
  hairline: "#26262E"
  primary-ink: "#EDEDF1"
  secondary-ink: "#8A8A95"
  high-signal-blue: "#5B8CFF"
  evidence-green: "#46C773"
  caution-amber: "#E0A52B"
  destructive-red: "#F25555"
typography:
  headline:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.35
rounded:
  control: "6px"
  field: "8px"
  surface: "12px"
  pill: "999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.high-signal-blue}"
    textColor: "#FFFFFF"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "32px"
  button-quiet:
    backgroundColor: "{colors.quiet-control}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "30px"
  composer:
    backgroundColor: "{colors.workspace-charcoal}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.surface}"
    padding: "8px"
  status-pill:
    backgroundColor: "{colors.workspace-charcoal}"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 9px"
    height: "22px"
---

# Design System: PiKVM Desktop

## Overview

**Creative North Star: "The Operator's Desk"**

PiKVM Desktop should feel like the desk of a careful expert: the conversation is
open in front of them, the computer they are operating is within sight, and the
few controls they may need are exactly where their hand expects them. The
interface is quiet, precise, and trustworthy. It favours one coherent workspace
over a collection of monitoring panels.

Chat is the primary surface. The live computer, activity evidence, approvals,
diagnostics, and manual KVM controls are supporting context that
appears when useful and recedes when it is not. Density comes from concise
language and strong hierarchy, not from tiny typography or unexplained
telemetry. The system explicitly rejects NOC dashboards, terminal cosplay,
verbose tool consoles, hidden operators, and generic chatbots that conceal
effects.

**Key Characteristics:**

- Conversation-first hierarchy with a collapsible computer preview.
- Compact native desktop chrome and generous space for task content.
- Effects shown through target crops, exact text, and evidence—not coordinates.
- Restrained neutral surfaces with colour reserved for action and truth.
- Keyboard-complete interaction, visible focus, reduced motion, and 200% scaling.

## Colors

The palette is near-neutral and restrained; saturated colour is scarce because
it must remain meaningful during consequential computer work.

### Primary

- **High-signal blue** (`#5B8CFF`): primary actions, active resize affordances,
  keyboard focus, and the one current selection that needs immediate attention.

### Neutral

- **Operator black** (`#0A0A0C`): application background and deep computer canvas.
- **Workspace charcoal** (`#121216`): titlebar, composer, and raised control surfaces.
- **Quiet control** (`#1A1A20`): hover and secondary-control fill.
- **Active surface** (`#23232B`): selected tabs and deliberate emphasis.
- **Hairline** (`#26262E`): structural one-pixel dividers.
- **Primary ink** (`#EDEDF1`): headings and high-value body text.
- **Secondary ink** (`#8A8A95`): metadata and supporting labels only.

### Semantic

- **Evidence green** (`#46C773`): independently verified or effect-observed state.
- **Caution amber** (`#E0A52B`): approval, degraded verification, or recoverable risk.
- **Destructive red** (`#F25555`): irreversible commitment, rejection, or failure.

**The Scarce Colour Rule.** High-signal blue occupies no more than ten percent
of a normal workspace. Green, amber, and red communicate meaning in words and
icons as well as colour.

## Typography

**Display Font:** Geist Variable (with system UI fallback)

**Body Font:** Geist Variable (with system UI fallback)

**Label/Mono Font:** Platform monospace, only for exact input and immutable identifiers

**Character:** A single modern grotesk keeps the app native and legible. Weight
and spacing establish hierarchy; decorative type pairing would compete with the
remote computer and the task.

### Hierarchy

- **Headline** (600, 24px, 1.25): empty-state and sheet titles.
- **Title** (600, 14px, 1.4): task titles, tool effects, and section anchors.
- **Body** (400, 14px, 1.55): conversation and explanatory text, capped at 72ch.
- **Label** (550, 12px, 1.35): tabs, status, metadata, and compact controls.
- **Exact input** (400, 12–13px, 1.5): literal text, code, hashes, and MCP arguments.

**The Read-Once Rule.** User-facing effects use plain language at body or title
size. Raw tool names and identifiers never become the dominant hierarchy.

## Elevation

The system is flat by default. Depth is conveyed through tonal layering and
one-pixel structure. Shadows are reserved for surfaces that genuinely leave the
document plane: dialogs, menus, and transient approval prompts. Resting chat,
computer and activity surfaces do not receive decorative shadows.

### Shadow Vocabulary

- **Floating menu** (`0 8px 24px rgba(0,0,0,0.32)`): menus and popovers only.
- **Modal focus** (`0 12px 34px rgba(0,0,0,0.45)`): blocking dialogs only.
- **Focus halo** (`0 0 0 3px color-mix(in srgb, #5B8CFF 18%, transparent)`):
  keyboard focus and an actively dragged divider.

**The Flat-by-Default Rule.** A shadow must explain layering or focus. It may
not be paired with a decorative one-pixel card border.

## Components

Components are refined and restrained: compact controls, full-size task
content, honest state, and no nested-card scaffolding.

### Buttons

- **Shape:** six-pixel radius for normal controls; circular only for icon-only actions.
- **Primary:** high-signal blue with white text, 32px high, used once per decision.
- **Hover / Focus:** quiet tonal shift on hover; a three-pixel blue focus halo on
  `:focus-visible`; no bounce or scale animation.
- **Secondary / Ghost:** transparent at rest, quiet-control fill on hover.

### Chips

- **Style:** full pill only for compact state or provider identity.
- **State:** pair the status word with a clear icon; colour reinforces rather than
  replaces the wording.

### Cards / Containers

- **Corner Style:** eight to twelve pixels when a boundary is semantically useful.
- **Background:** workspace charcoal or quiet control against operator black.
- **Shadow Strategy:** flat at rest; tonal separation before shadow.
- **Border:** one-pixel hairline where structure needs it, never a coloured side stripe.
- **Internal Padding:** twelve or sixteen pixels; tool summaries remain one compact row.

### Inputs / Fields

- **Style:** workspace-charcoal composer with an eight-to-twelve-pixel radius and
  a subtle hairline.
- **Focus:** high-signal blue focus halo with no layout shift.
- **Error / Disabled:** error text remains readable and explicit; disabled controls
  retain labels and never rely on opacity alone.

### Navigation

The task title and live status sit in one 56px header. Chat is the default view. Supporting
computer, model, and diagnostic views use labelled tooltips and keyboard
shortcuts. At narrow widths, history moves into a sheet rather than shrinking
the conversation.

### Computer Action

Each action leads with the intended effect. A click shows a target crop and
named control; typing shows exact intended content and delivery state. Attempted,
committed, verified, and effect-observed are distinct states. Coordinates,
hashes, model receipts, and exact MCP arguments remain available on demand.

## Do's and Don'ts

### Do:

- **Do** make chat the control surface and keep the current computer visible as
  supporting context.
- **Do** show effects with target crops, before/after frames, exact text, and
  independent evidence.
- **Do** keep controls at least 32px high with a visible `:focus-visible` state.
- **Do** use evidence green, caution amber, and destructive red together with
  words and icons.
- **Do** honour `prefers-reduced-motion` and keep the product usable at 200% scale.

### Don't:

- **Don't** present a verbose developer console as the user-facing harness.
- **Don't** build a NOC dashboard full of panels, telemetry cards, and
  unexplained coordinates.
- **Don't** use a terminal-themed interface that treats logs as visibility.
- **Don't** ship a generic chatbot that hides tool execution or shows only a spinner.
- **Don't** use a hidden operator whose decisions and screen state cannot be inspected.
- **Don't** recreate production-ready chat, tool-call, dialog, or form primitives.
- **Don't** add decorative motion, gratuitous glass effects, or “AI control centre” styling.
- **Don't** use coloured side stripes, gradient text, nested cards, or borders
  paired with wide decorative shadows.
