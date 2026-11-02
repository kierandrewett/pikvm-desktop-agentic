# Model-provider support policy

The harness owns one provider-neutral reason → act → verify loop. Model
providers supply structured decisions and pixels; they never receive raw
PiKVM tools or direct authority over the target.

This document describes the adapter contract. It does **not** claim that every
provider account, model alias, CLI version, region, or quota works live. Dated
compatibility and performance evidence belongs in the
[public benchmark scorecard](../bench/README.md).

## Support tiers

- `stable` — a first-party adapter with fail-closed configuration, isolated
  pixel input, structured-output validation, error normalization, timeout and
  cooldown handling, secret-redaction tests, and a backwards-compatibility
  commitment.
- `beta` — a first-party adapter with the same local safety contract, but an
  incomplete live account/client/version matrix. Its configuration may change
  with an explicit migration note.
- `bridge` — a harness contract around an external protocol or process. The
  harness validates its boundary, but cannot guarantee the behavior or
  compatibility of the remote implementation.

A `stable` adapter is eligible for production use only when the exact
provider/client version and configured model also have current live evidence.

## Canonical matrix

| Provider kind | Tier | Interface | Authentication and owner | Pixel input | Output contract |
|---|---|---|---|---|---|
| `codex_cli` | `stable` | Codex exec | saved CLI login; provider CLI | native image attachment | strict JSON Schema |
| `codex_app_server` | `beta` | persistent Codex app-server | saved CLI login; provider CLI | native local image input | strict JSON Schema |
| `claude_cli` | `stable` | Claude print mode | saved CLI login; provider CLI | isolated Read artifact | strict JSON Schema |
| `gemini_cli` | `beta` | Gemini headless mode | saved CLI login; provider CLI | isolated `@` image artifact | harness-validated JSON |
| `openai_responses` | `stable` | OpenAI Responses API | API-key environment; harness environment | native image input | strict JSON Schema |
| `anthropic_api` | `stable` | Anthropic Messages API | API-key environment; harness environment | base64 image block | JSON Schema |
| `gemini_api` | `stable` | Gemini `generateContent` | API-key environment; harness environment | inline image data | JSON Schema |
| `azure_openai_responses` | `beta` | Azure OpenAI Responses API | API-key/bearer environment or exact CLI bearer command; environment or provider CLI | native image input | strict JSON Schema |
| `vertex_gemini` | `beta` | Vertex AI Gemini `generateContent` | bearer environment or exact CLI bearer command; environment or provider CLI | inline image data | JSON Schema |
| `openai_compatible` | `bridge` | Chat Completions API | API-key environment; harness environment | image data URL | strict JSON Schema |
| `subprocess_json` | `bridge` | custom subprocess | external or bridge-owned | bridge-defined | harness-validated JSON |

The executable code source of truth is
`pikvm_agent/harness/provider_support.py`. Tests require every configurable
provider kind to have exactly one contract and require this policy to name
every contract.

## Credential ownership

The harness never reads or copies a saved CLI credential. Codex app-server,
Codex exec, Claude, and Gemini CLI processes own their login stores. API
secrets are named by environment variable or stored through the write-only key
endpoint (below), and are neither written to harness configuration nor returned
by readiness, health, support-bundle, UI, or conformance endpoints.

Azure and Vertex command credentials are obtained through an exact argument
vector with empty standard input and an allow-listed environment. Only the
resulting authorization header is used for that provider request. Raw command
output and credential values are not persisted.

`subprocess_json` is deliberately marked external: credential handling inside
the bridge remains the bridge operator's responsibility.

## First-party connection flow

The Models sheet provides an additive setup flow for the provider-owned Codex
app-server/CLI, Claude CLI, and Gemini CLI logins and four common API routes
(`openai_responses`, `anthropic_api`, `gemini_api`, and
`openai_compatible`). This form never accepts a credential value. It sends
only a unique provider alias, model ID, optional safe base URL, and the name of
the server environment variable that already owns an API credential; a key is
accepted only by the separate write-only routes described below.
Provider-owned login processes continue to use their own login store.

New providers are written atomically to the harness configuration with mode
`0600`, cannot replace an existing alias, become visible without silently
changing any reasoner/controller/verifier route, and reject credential-like
values in public text fields. A harness with an active per-run cost cap refuses
browser setup until billing terms are reviewed in configuration. Azure, Vertex,
and custom subprocess routes remain reviewed configuration work rather than a
simplified browser flow.

This is not a hosted OAuth broker. The only OAuth involved in the simple flow
is the provider CLI's own sign-in outside the browser form.

## Stored API keys and browser sign-in

Two groups of operator-only routes extend the flow above without changing it; the
plain `POST /api/providers` still accepts no credential value.

**Stored keys.** `PUT /api/providers/{alias}/key` with `{"api_key": "..."}` is
the one place a key is accepted. It is stored in `provider-keys.json` beside the
harness config (file `0600`, directory `0700` when created, atomic replace), never
in the YAML, never returned, and never logged (`api_key` and `auth_code` are in
the redaction set; these bodies are parsed by hand so a validation error cannot
echo them). A provider resolves its stored key first and falls back to its named
environment variable on every request, so setting, replacing, or removing a
key takes effect at once and readiness in `GET /api/providers` follows it
(`credential: stored-key`). `DELETE` removes it; `GET /api/provider-keys` lists
`set`, `updated_at`, and `source` (`stored`, `environment`, `missing`) per API
provider. `POST /api/providers/with-key` connects a provider and stores its key
in one call. A file store was chosen over the OS keyring because the harness
is a child of the desktop app or a headless service where Secret Service may be
absent or locked; encrypting the file would need a key stored next to it.

**CLI sign-in.** `GET /api/cli-auth` reports, per CLI, whether it is installed
and signed in. `POST /api/cli-auth/{cli}/sign-in` runs the CLI's own login and
returns the verification URL (and one-time code) it prints; the attempt is
polled with `GET`, finished with `DELETE` (cancel), and
`POST .../sign-out` runs the CLI's logout. Codex (`codex login --device-auth`)
shows a URL and a one-time code. Claude (`claude auth login`) shows a URL; the
page it leads to shows a code that is pasted back through
`POST .../sign-in/code` and written to the CLI's stdin. Gemini CLI has no login
command (sign-in is inside its interactive terminal UI), so the API reports
`browser_sign_in: false` with the exact command to run on the desktop. Signing
in over an existing login needs `replace: true`: with codex-cli 0.158 a device
flow that is cancelled or fails removes the saved `auth.json` (observed), which
leaves the CLI signed out. The harness still never reads a CLI's tokens;
status comes from the CLI's own status command (Gemini: the presence of its
credential file and the active account name only).

## Readiness is not compatibility

Readiness checks are local and non-billable. They prove only that a configured
executable, dedicated profile directory, or named environment value is
present. They do not prove login validity, quota, model access, endpoint
compatibility, output accuracy, or latency.

Live compatibility requires the explicit, potentially billable blind
conformance command. Its report includes unavailable and failed providers in
the denominator and records the configured model, returned model identities,
exact/schema accuracy, failure classes, usage, median latency, and p95 latency.
The operator UI labels prerequisite-only state as unproven.

## Reasoning effort

`codex_app_server` accepts `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max` and defaults to `low`. It can also forward an app-server
`service_tier`, such as `priority`. The adapter keeps one authenticated Codex
process alive while creating one ephemeral, tool-disabled thread per request.
This removes repeated CLI startup but does not bypass model inference or
guarantee that an account can use a particular model or service tier.

`claude_cli` accepts an optional `reasoning_effort` value of `low`, `medium`,
`high`, `xhigh`, or `max` and forwards it as the Claude CLI `--effort`
argument. The harness does not force an effort for generated Claude providers.
It is a route-specific tuning control, not a guaranteed fast path: the current
paired Calculator diagnostic found that forcing `low` on both controller and
verifier more than doubled wall time by creating extra action/verification
rounds. Any promoted default must therefore pass the same action-quality and
latency acceptance path, not merely reduce one provider call.

## Version and change policy

- Stable provider kinds and configuration fields are not silently removed.
  A replacement is introduced first, the old form remains accepted for at
  least one minor release, and the release notes state the migration.
- Beta changes require a migration note but may land without a deprecation
  window when an upstream provider makes the existing interface unusable.
- Bridge compatibility is versioned at the harness boundary only. Third-party
  servers and subprocesses must be re-qualified by blind conformance.
- A provider, CLI, model, or endpoint change invalidates prior live evidence
  for that combination until the same benchmark is rerun.
- Authentication failures, rate limits, timeouts, schema failures, and model
  mismatches remain visible as coarse durable evidence; they never silently
  select an unsafe machine action.

## Promotion criteria

A beta adapter can move to stable after its local contract is complete and at
least two independently repeated live runs pass the blind conformance suite
for supported authentication modes, with client/provider versions and dated
evidence published. Office and public computer-use benchmark results are
reported separately because provider conformance alone does not measure safe
end-to-end computer operation.
