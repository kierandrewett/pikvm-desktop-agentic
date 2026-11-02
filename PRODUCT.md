# Product

## Register

product

## Users

PiKVM Desktop serves technical operators, developers, administrators, and
knowledge workers who need an AI model to operate a remote computer while they
remain able to see, understand, interrupt, and approve what is happening.

The primary workflow is conversational: the user describes an outcome, watches
the live computer and action evidence, intervenes when needed, and receives a
verified result. Manual KVM controls remain available as supporting tools and
recovery paths rather than a competing primary interface. There is no terminal.

## Product Purpose

PiKVM Desktop is a first-party computer-use harness, not a decorative wrapper
around a coding CLI and not a hidden autonomous operator. It provides one stable
control plane across PiKVM, disposable VNC-backed test machines, OAuth-backed
model CLIs, and API-based providers.

External clients such as Claude Code, Codex, and OpenCode may submit tasks,
inspect status, or use a guarded compatibility boundary. The harness owns task
progression, per-role provider routing, raw input execution, target-bound
approval, verification, interruption and quiescence, evidence capture, and the
operator-visible timeline.

Success means:

- routine computer work can be completed from a chat-first desktop interface;
- every attempted, committed, verified, and observed effect is visible live;
- dangerous actions require meaningful approval immediately before commitment;
- long text, code, clicks, and recovery actions are measured and improved using
  disposable machines without weakening production safety;
- users can bring OAuth subscriptions or API credentials from multiple
  providers without being locked to one model vendor;
- published real-world benchmarks and failure records make reliability claims
  inspectable rather than promotional.

## Brand Personality

Quiet, precise, trustworthy.

The product should feel native, responsive, and professionally restrained.
Codex Desktop is a reference for conversational flow, Raycast for desktop
density and immediacy, and Linear for legible state and consistent interaction.
The interface should disappear into the work while keeping consequential
computer actions unusually visible.

## Anti-references

- A verbose developer console presented as a user-facing harness.
- A NOC dashboard full of panels, telemetry cards, and unexplained coordinates.
- A terminal-themed interface that assumes logs are equivalent to visibility.
- A generic chatbot that hides tool execution or shows only spinner/status text.
- A hidden operator model whose inner decisions and screen state cannot be
  inspected by the user.
- A home-grown imitation of mature chat, tool-call, dialog, and form components
  when production-ready libraries already solve them.
- Decorative motion, gratuitous glass effects, and “AI control centre” styling.

## Design Principles

1. **Chat is the control surface.** The conversation, current computer state,
   tool execution, evidence, approvals, and outcome belong in one coherent
   workspace.
2. **Show effects, not coordinates.** Prefer screen crops, before/after evidence,
   exact input previews, and named targets over low-level arguments unless the
   user asks for them.
3. **The harness owns consequential execution.** Models can reason and propose;
   the first-party control plane sequences, commits, verifies, interrupts, and
   records.
4. **Provider flexibility without behavioural drift.** OAuth and API providers
   share one task, safety, evidence, and metrics contract, with provider/model
   identity recorded per decision and action.
5. **Fail visibly and recover deliberately.** A timeout, focus loss, stale frame,
   partial input, or interrupted action is a first-class state, never silently
   flattened into “tool completed.”
6. **Evidence earns trust.** Accuracy, speed, safety, OCR, and benchmark claims
   must link to reproducible runs and known failures.

## Accessibility & Inclusion

Target WCAG 2.2 AA. All primary workflows must support keyboard navigation,
visible focus, screen-reader labels, colour-independent status communication,
reduced motion, and usable scaling through 200 percent. Dense operational
information must remain readable without requiring precision pointer input.
