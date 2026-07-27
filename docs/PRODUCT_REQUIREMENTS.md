# PiKVM Harness Product Requirements

This is the scope ledger for the product discussed in the originating thread.
It spans this desktop shell and the sibling `pikvm-agent` control plane. A green
unit test is not sufficient evidence for a live or product-level requirement.

Status vocabulary:

- **Proved** — current, authoritative evidence covers the requirement.
- **Implemented, live proof pending** — the path exists but the requested
  real-world acceptance gate has not passed.
- **Partial** — meaningful pieces exist, but the requirement is not true
  end-to-end.
- **Missing** — no adequate implementation or evidence exists.

Current live checkpoint (2026-07-27):

- an isolated development desktop started its owned harness, waited for health,
  authenticated the embedded chat without exposing the operator credential, and
  settled after one intentional bootstrap reload;
- Claude CLI connected through the stable guarded launcher and the harness
  observed only the read-only direct-health handshake;
- the already-running production desktop/daemon was adopted read-only and no
  keyboard, pointer, or remote HID action was issued.

## 1. Product and control architecture

| Requirement | Current status | Evidence needed for completion |
|---|---|---|
| A first-party, chat-first computer-use harness rather than a coding-CLI console | **Partial** | PiKVM Desktop boots directly into the authenticated assistant-ui workspace; operator completes a live task there |
| Harness owns progression, raw HID, verification, approvals, interruption, and evidence | **Partial** | Coding clients receive only high-level task/status/control tools in managed mode; live run proves no raw-HID bypass |
| Normal Claude/Codex/OpenCode compatibility remains available without becoming an invisible second control plane | **Partial — Claude connected; Codex/OpenCode pending** | Each remaining client connects through managed or guarded-direct boundary; calls appear live with correct identity and effect state |
| Runtime-selected PiKVM or VNC target; no VNC endpoint hard-coded in source/config | **Proved** | `pikvm-agent/docs/VNC_HARNESS.md` contract plus endpoint-leak scan |
| Disposable VNC labs cannot collide with or mutate the production PiKVM session | **Partial** | Concurrent isolation test, target attestation, lease test, and production process/port invariant during live suite |

## 2. Provider flexibility and routing

| Requirement | Current status | Evidence needed for completion |
|---|---|---|
| OAuth providers: Codex, Claude, Gemini | **Implemented, live proof pending** | Dated provider-conformance passes for every supported OAuth adapter |
| API providers: OpenAI Responses, Anthropic, Gemini, Azure OpenAI, Vertex, OpenAI-compatible gateways | **Implemented, live proof pending** | Contract and live conformance matrix covering auth, schema, tool protocol, usage, cancellation, and failure modes |
| Different reasoner/controller/verifier routes, with fast controller and stronger reasoner/verifier choices | **Implemented, live proof pending** | Mixed-model live task with per-role provider/model attribution and latency/cost accounting |
| BYO credentials remain outside persisted harness config and browser-visible state | **Partial** | Secret-leak scans across config, process args, support bundles, browser storage, logs, artifacts, and crash recovery |
| Stable behaviour across providers rather than provider-specific safety semantics | **Partial** | Same seeded task/safety corpus run through every provider with normalized outcome comparison |

## 3. Operator visibility

| Requirement | Current status | Evidence needed for completion |
|---|---|---|
| Responsive, lightweight chat interface is the only primary harness surface | **Partial** | Desktop screenshot/interaction audit at common widths; no console-first or terminal-first default |
| Live screen remains visible and inspectable during model/tool activity | **Implemented, live proof pending** | Long task shows current frame without hiding the conversation or blocking input |
| Tool calls show attempted → committed → verified → effect-observed states | **Partial** | Production-shaped direct and managed traces render truthful states; no unverified action appears complete |
| Clicks show a visual crop/target preview rather than coordinates alone | **Partial** | Guarded-direct and managed clicks both retain pre-action evidence and render the actual target crop |
| Typing shows exact intended input, delivery progress, OCR/read-back, and correction | **Partial** | Long prose/code live acceptance with exact observer bytes and independent visual verification |
| Caller, role, provider, and model are recorded per decision and action | **Partial** | Mixed-model and direct-client runs display actual call-level attribution; stale session labels cannot override it |
| Approvals and interruption are available in the same conversation timeline | **Implemented, live proof pending** | Live dangerous action pauses inline; operator approves/denies/aborts without leaving the workspace |

## 4. Input, OCR, and recovery accuracy

| Requirement | Current status | Evidence needed for completion |
|---|---|---|
| Long prose and code can be entered accurately without fragile base64 transport hacks | **Partial** | Seeded text/code corpus on Windows and Linux with exact observer bytes, visual OCR, timing, retries, and final file hash |
| Windows lab observer records exact keys, pointer input, committed text, and file contents | **Implemented, live proof pending** | Installed observer capability/version preflight plus passing live report from the disposable VM |
| Harness compares a remote file with the exact tool-call payload | **Implemented, live proof pending** | Live save/read/compare acceptance with mismatch injection and recovery |
| At least 1,000 randomized blind OCR cases | **Proved offline only** | Existing seeded n=1000 reports remain reproducible; live-screen transfer test still required |
| OCR is evaluated blind, with exact/normalized edit distance, boxes, confidence, and latency | **Partial** | Current scorecard aggregated across fonts, scaling, themes, terminal/editor/browser surfaces, and both OS targets |
| Focus loss, partial typing, stale frames, layout mismatch, and submit races recover deterministically | **Partial** | Historical regressions plus observer-backed injected-fault live tests prove bounded correction or fail-closed stop |
| Panic/abort reaches quiescence and releases all keys | **Partial** | In-flight long burst interrupted under load; no post-stop input; server reports zero active transactions and released modifiers |

## 5. Safety and permissions

| Requirement | Current status | Evidence needed for completion |
|---|---|---|
| Dangerous commands require approval immediately before Enter/click | **Partial** | Live `terraform apply/destroy`, cloud delete/terminate, force flags, and scripted auto-approve cases all pause at commitment |
| Sending Teams/Slack/email messages, calls, shares, saves, deletes, purchases, and equivalent UI actions are treated as consequential | **Partial** | Seeded 1,000-case adversarial corpus plus live UI cases with OCR ambiguity and focus theft |
| Approval is bound to exact payload, target, screen world, epoch, session, and action | **Implemented, live proof pending** | Stale/replayed/altered approval attempts are rejected in live harness |
| Models never receive an approval-resolution tool | **Proved by contract** | Public MCP inventory tests stay green |
| Direct compatibility calls are visible and guarded rather than silently trusted | **Implemented, live proof pending** | Direct call appears before input, receives correct dynamic danger decision, and cannot commit while UI/observer path is unavailable |

## 6. Real-world evaluation

| Requirement | Current status | Evidence needed for completion |
|---|---|---|
| Routine Office tasks: spreadsheet, essay/document, and saved artifacts | **Partial** | Live Word and Excel acceptance passes with observer-owned file evidence; current README explicitly records no passing supplied-VM result |
| OSWorld through the actual MCP/harness/live-model path | **Partial** | Dated task set, task IDs, provider/model, environment, success/failure, latency, actions, approvals, and artifacts |
| ScreenSpot-Pro pointing accuracy | **Partial** | Official split/protocol results with target crops and coordinate error distribution |
| Windows Agent Arena | **Missing live proof** | Official or faithfully adapted task set with reproducible VM reset and artifact capture |
| Per-model speed and accuracy comparisons | **Partial** | Same task seeds and environment across models; reasoner/controller/verifier latency, token use, actions, corrections, and success |
| Windows and Linux targets | **Missing product gate** | Observer-backed accuracy benchmark passes on both OS families |

## 7. Historical failure learning

| Requirement | Current status | Evidence needed for completion |
|---|---|---|
| Deep audit of Claude, Codex, and OpenCode conversations that used PiKVM tools | **Partial but substantial** | Corrected incident ledger covers every discovered session and records source index, call-level model, failure, correction, danger, and regression |
| Reference conversation route is understood accurately | **Proved** | 551/551 PiKVM calls in `737f59a5-cba2-44aa-ad94-669b120c6403` were direct |
| Model attribution is call-level, not inferred from session metadata | **Partial** | Importers persist caller/provider/model per tool call; unknown inner operator models remain explicitly unknown |
| Every material historical failure becomes a test or an explicit uncovered risk | **Partial** | Coverage ledger corrected for omitted base64 chunks, destructive actions, mixed attribution, OpenCode dry-run auto-approve, focus theft, long-input hangs, and panic-stop failures |

## 8. Product evidence and delivery

| Requirement | Current status | Evidence needed for completion |
|---|---|---|
| Centralized, public real-world results in the main README | **Partial** | One evidence table links each claim to dated machine-readable reports and clearly labels failures/pending gates |
| Failure-inclusive reporting; no cherry-picked pass claims | **Partial** | Scorecard includes attempted, failed, corrected, unsupported, and blocked runs |
| Tool/action efficiency, wall time, model time, corrections, safety pauses, OCR, and exactness metrics | **Partial** | Schema and dashboards validated on long live runs |
| Small validated commits while iterating, pushed promptly | **In progress** | Desktop integration and remaining harness fixes committed in reviewable slices and pushed |
| Final product branch merged to `master`/`main` only after the full gate | **Not ready** | Requirement-by-requirement completion audit proves every product gate above |
