/**
 * Our server API, `/app/api/v1/*`.
 *
 * The same definition is implemented by the Node server (src/server/api) and
 * consumed by the web app through `HttpApiClient`, so a change here is a type
 * error on both sides instead of a runtime surprise on one.
 *
 * What is deliberately NOT here: anything secret. `accessToken`, the PiKVM
 * password and the desktop capabilities stay on the server. Settings are an
 * explicit allow-list of user-editable fields, not a view of the settings file.
 */

import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

/** The layout of the physical keyboard the target expects. */
export const KeyboardLayout = Schema.Literal("us", "uk");
export type KeyboardLayout = typeof KeyboardLayout.Type;

/** What the idle mouse-jiggler has been doing: the evidence trail for "my
 *  target went to sleep anyway". Mirrors `JigglerStatus` in src/mouse-jiggler.ts. */
export const JigglerStatus = Schema.Struct({
    enabled: Schema.Boolean,
    /** `pi`: kvmd's own jiggler is running it. `local`: we nudge from here. */
    mode: Schema.Literal("pi", "local"),
    /** How many times we had to switch the Pi's jiggler back on. */
    nativeSwitchOns: Schema.Number,
    /** ms since the epoch of the last successful nudge; 0 if never. */
    lastNudgeAt: Schema.Number,
    nudges: Schema.Number,
    /** Consecutive failures since the last success. */
    failures: Schema.Number,
    lastError: Schema.optional(Schema.String),
});
export type JigglerStatus = typeof JigglerStatus.Type;

/** Whether the agent's program is installed where the host looks, and if not, why. */
export const AgentRuntime = Schema.Struct({
    found: Schema.Boolean,
    reason: Schema.optional(Schema.String),
});
export type AgentRuntime = typeof AgentRuntime.Type;

/** What this host actually serves, so the app does not draw a panel whose
 *  socket would only ever close. */
export const Features = Schema.Struct({
    /** The chat server inside this host is up: conversations, providers and settings work. */
    chat: Schema.Boolean,
    /** The agent program the chat server starts; without it a conversation cannot be answered. */
    agent: Schema.optional(AgentRuntime),
});
export type Features = typeof Features.Type;

/** The user-editable settings: the fields the Settings pages may show and
 *  change. Everything else in the settings file is intentionally absent. */
export const Settings = Schema.Struct({
    keyboardLayout: KeyboardLayout,
    jiggler: Schema.Boolean,
});
export type Settings = typeof Settings.Type;

/** A change to {@link Settings}: any subset. An unknown key (`accessToken`,
 *  say) is a 400, not a silent no-op, so a client that thinks it can set a
 *  secret here finds out at once. */
export const SettingsPatch = Schema.Struct({
    keyboardLayout: Schema.optional(KeyboardLayout),
    jiggler: Schema.optional(Schema.Boolean),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type SettingsPatch = typeof SettingsPatch.Type;

/** Where the server forwards kvmd traffic, and what it knows of the link.
 *  `link` is `connected` once kvmd's event socket has delivered state, else
 *  `unknown`: the server holds that socket open lazily, so "not yet" is not
 *  the same as "down". */
export const PikvmTarget = Schema.Struct({
    origin: Schema.String,
    link: Schema.Literal("connected", "connecting", "offline", "unknown"),
});
export type PikvmTarget = typeof PikvmTarget.Type;

/** The PiKVM this host connects to, as a client may see it. `editable` is true only where the host owns
 *  the setting (the desktop app); a hosted build pins it by environment and says so here. The password
 *  is never part of any reply: `passwordSet` is all a client learns. */
export const TargetConfig = Schema.Struct({
    origin: Schema.String,
    username: Schema.String,
    passwordSet: Schema.Boolean,
    editable: Schema.Boolean,
});
export type TargetConfig = typeof TargetConfig.Type;

/** A change to the target: any subset. `password` is write-only: omitted keeps it, "" removes it. Credentials
 *  typed into `origin` (`https://user:pass@pikvm/`) are taken as the user name and password. */
export const TargetPatch = Schema.Struct({
    origin: Schema.optional(Schema.String),
    username: Schema.optional(Schema.String),
    password: Schema.optional(Schema.String),
}).annotations({ parseOptions: { onExcessProperty: "error" } });
export type TargetPatch = typeof TargetPatch.Type;

/** `GET /state`: everything the app needs to start. */
export const State = Schema.Struct({
    settings: Settings,
    features: Features,
    jigglerStatus: JigglerStatus,
    pikvm: PikvmTarget,
    /** The app's version (package.json). */
    version: Schema.String,
});
export type State = typeof State.Type;

/* ------------------------------------------------------------------ */
/* Macros                                                              */
/* ------------------------------------------------------------------ */

/* The limits are the ones src/macros.ts (MacroStore) applies on write. They
 * are written here so the editor can enforce them before saving instead of
 * learning from a dropped step. */

/** A physical key code (`KeyS`, `F5`, `ControlLeft`). */
const MacroKeyCode = Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9]{0,23}$/));

export const MacroChordStep = Schema.Struct({
    type: Schema.Literal("chord"),
    /** Modifiers held while `code` is pressed; at most 6. */
    mods: Schema.Array(MacroKeyCode).pipe(Schema.maxItems(6)),
    code: MacroKeyCode,
});

/** Text typed on the target through the Pi's own keymap. */
export const MacroTextStep = Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
});

/** A pause for targets that need a moment between steps. */
export const MacroDelayStep = Schema.Struct({
    type: Schema.Literal("delay"),
    ms: Schema.Number.pipe(Schema.between(1, 10_000)),
});

export const MacroStep = Schema.Union(MacroChordStep, MacroTextStep, MacroDelayStep);
export type MacroStep = typeof MacroStep.Type;

export const Macro = Schema.Struct({
    id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
    label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(60)),
    /** A named icon from the console's set, or (for macros written before the
     *  picker existed) one or two literal characters. */
    icon: Schema.optional(Schema.String),
    /** Show it in the titlebar's custom area instead of only the menu. */
    pinned: Schema.optional(Schema.Boolean),
    /** 1 to 40 steps. */
    steps: Schema.Array(MacroStep).pipe(Schema.minItems(1), Schema.maxItems(40)),
});
export type Macro = typeof Macro.Type;

/** At most 60 macros. This is what the server stores and returns. */
export const MacroList = Schema.Array(Macro).pipe(Schema.maxItems(60));

export const MacrosResponse = Schema.Struct({ macros: MacroList });
export type MacrosResponse = typeof MacrosResponse.Type;

/** What `PUT /macros` accepts: a bare array or `{macros}`. Deliberately loose.
 *  The server applies the store's own validation, which DROPS a macro or step
 *  it cannot read rather than rejecting the whole save (one bad macro should
 *  not cost the user the other fifty). Only a body that is not a list at all
 *  is refused, because saving that would wipe every macro and report success. */
export const MacrosPayload = Schema.Union(
    Schema.Array(Schema.Unknown),
    Schema.Struct({ macros: Schema.Array(Schema.Unknown) }),
);
export type MacrosPayload = typeof MacrosPayload.Type;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Every error body from this API carries `error: string`, whichever layer
 *  produced it. The Node adapter rewrites the framework's own decode failures
 *  into this shape so a client reads one field. */
export class BadRequest extends Schema.Class<BadRequest>("BadRequest")(
    { error: Schema.String },
    HttpApiSchema.annotations({ status: 400 }),
) {}

/** The host does not let the app change this (a hosted build pins it by environment). `pinned` is what makes this
 *  shape different from {@link BadRequest}: with the same fields the encoder cannot tell the two apart and sends
 *  the first one's status. */
export class Forbidden extends Schema.Class<Forbidden>("Forbidden")(
    { error: Schema.String, pinned: Schema.Literal(true) },
    HttpApiSchema.annotations({ status: 403 }),
) {}

/* ------------------------------------------------------------------ */
/* The API                                                             */
/* ------------------------------------------------------------------ */

export const API_PREFIX = "/app/api/v1";

/* ------------------------------------------------------------------ */
/* The agent on the KVM tab                                            */
/* ------------------------------------------------------------------ */

/** What the agent is doing with the PiKVM. Mirrors `AgentActivity` in @pikvm/mcp. */
export const AgentState = Schema.Literal("idle", "working", "waiting_approval", "released");
export type AgentState = typeof AgentState.Type;

export const AgentActivity = Schema.Struct({
    state: AgentState,
    conversationId: Schema.optional(Schema.String),
    /** The tool in flight, or the last one, without the server prefix. */
    tool: Schema.optional(Schema.String),
    /** Where the agent's pointer is, as fractions of the picture. */
    pointer: Schema.optional(Schema.Struct({ fx: Schema.Number, fy: Schema.Number })),
    /** Why control ended, with `released`: a person took over, Stop, or a lease that ran out. */
    reason: Schema.optional(Schema.Literal("operator", "stopped", "lease_timeout")),
    /** Epoch milliseconds. */
    at: Schema.Number,
});
export type AgentActivity = typeof AgentActivity.Type;

/** Server-sent events: one `AgentActivity` as JSON per event, the current one first. */
export const AGENT_ACTIVITY_PATH = `${API_PREFIX}/agent/activity`;
/** POST: the person pressed Stop. Releases control, cancels the running responses. */
export const AGENT_STOP_PATH = `${API_PREFIX}/agent/stop`;
/** POST: the person gives control back to the run they took it from. */
export const AGENT_HANDBACK_PATH = `${API_PREFIX}/agent/handback`;

export const AgentStopResult = Schema.Struct({ stopped: Schema.Boolean });
export const AgentHandBackResult = Schema.Struct({ handedBack: Schema.Number });

/* ------------------------------------------------------------------ */
/* The shared cursor                                                   */
/* ------------------------------------------------------------------ */

/**
 * Where the target's pointer is, as the host last saw it move, in kvmd's own units (-32768..32767 on both axes, so
 * a fraction of the picture and the same at any resolution). `source` is the client that moved it: the client id
 * the page put on its input socket, `agent` for the chat agent's tools, or a name the host made up for a client
 * that sent none. `seq` grows with every change; a client that sees a lower one than it has seen has met a newer
 * host and starts again.
 */
export const CursorUpdate = Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    source: Schema.String,
    seq: Schema.Number,
});
export type CursorUpdate = typeof CursorUpdate.Type;

/** Server-sent events: one `CursorUpdate` as JSON per event, at most one per frame, the current one first (none while unknown). */
export const CURSOR_PATH = `${API_PREFIX}/cursor`;
/** The query parameter a page puts on its `/api/ws` URL to say which client it is. The host removes it before the Pi sees the request. */
export const CURSOR_CLIENT_PARAM = "client";
/** The source name the chat agent's tools move the pointer under. */
export const CURSOR_AGENT_SOURCE = "agent";

export const StateGroup = HttpApiGroup.make("state").add(HttpApiEndpoint.get("get", "/state").addSuccess(State));

export const MacrosGroup = HttpApiGroup.make("macros")
    .add(HttpApiEndpoint.get("list", "/macros").addSuccess(MacrosResponse))
    .add(
        HttpApiEndpoint.put("replace", "/macros")
            .setPayload(MacrosPayload)
            .addSuccess(MacrosResponse)
            .addError(BadRequest),
    );

export const SettingsGroup = HttpApiGroup.make("settings")
    .add(HttpApiEndpoint.get("get", "/settings").addSuccess(Settings))
    .add(HttpApiEndpoint.patch("update", "/settings").setPayload(SettingsPatch).addSuccess(Settings));

export const TargetGroup = HttpApiGroup.make("target")
    .add(HttpApiEndpoint.get("get", "/target").addSuccess(TargetConfig))
    .add(
        HttpApiEndpoint.put("update", "/target")
            .setPayload(TargetPatch)
            .addSuccess(TargetConfig)
            .addError(BadRequest)
            .addError(Forbidden),
    );

export const PikvmApi = HttpApi.make("pikvm")
    .add(StateGroup)
    .add(MacrosGroup)
    .add(SettingsGroup)
    .add(TargetGroup)
    .prefix(API_PREFIX);
