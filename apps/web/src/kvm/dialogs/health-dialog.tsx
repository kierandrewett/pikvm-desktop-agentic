/**
 * System, GPIO and health: what is wrong (nothing is shown while all is well), the ATX power
 * controls with their LEDs, the mass-storage state, the user's GPIO outputs, the keyboard and
 * mouse attach state with its recovery buttons, and the About line.
 *
 * A control that disables itself on press would drop focus to the page, so double-tap guards
 * here are `aria-disabled` plus an ignored click, never `disabled`; `disabled` is reserved for
 * states the Pi reports (busy, offline).
 */

import { useId, useRef, useState } from "react";
import type { DialogProps } from "../dialog-seam";
import type { KvmSession } from "../session";
import { useTarget } from "../session";
import { pressAtx } from "./atx-dialog";
import { failureLine, kvmdPost } from "./kvmd";
import {
    aboutLine,
    anythingReported,
    ATX_COPY,
    atxView,
    gpioConfirmation,
    gpioOutputs,
    healthProblems,
    healthSummary,
    hidView,
    type AtxButton,
    type GpioOutput,
} from "./model/health";
import { msdSummary } from "./model/msd";
import { Btn, DialogShell, Note, Rule, useConfirm, type Confirmer } from "./shell";

/** A set of in-flight keys, so one channel's request never blocks another's. */
interface Pending {
    has(key: string): boolean;
    run(key: string, work: () => Promise<void>): Promise<void>;
}

function usePending(): Pending {
    const [, repaint] = useState(0);
    const keys = useRef<Record<string, true>>({});
    return {
        has: (key) => keys.current[key] === true,
        async run(key, work) {
            if (keys.current[key]) return;
            keys.current[key] = true;
            repaint((n) => n + 1);
            try {
                await work();
            } finally {
                delete keys.current[key];
                repaint((n) => n + 1);
            }
        },
    };
}

function GpioRow({
    output,
    pending,
    session,
    confirm,
}: {
    output: GpioOutput;
    pending: Pending;
    session: KvmSession;
    confirm: Confirmer;
}) {
    const labelId = useId();
    const key = `gpio:${output.name}`;
    const inFlight = pending.has(key);
    const unavailable = output.busy || !output.online;

    const act = async (action: "pulse" | "switch"): Promise<void> => {
        if (inFlight) return;
        const turningOn = !output.on;
        const question = gpioConfirmation(output, action, turningOn);
        if (question && !(await confirm.ask({ ...question, danger: true }))) return;
        await pending.run(key, async () => {
            const path =
                action === "pulse"
                    ? `/api/gpio/pulse?channel=${encodeURIComponent(output.name)}`
                    : `/api/gpio/switch?channel=${encodeURIComponent(output.name)}&state=${turningOn ? 1 : 0}`;
            const result = await kvmdPost(session, path);
            if (!result.ok) {
                session.notices.notify({
                    text:
                        result.status !== null
                            ? `Could not ${action === "pulse" ? "pulse" : "switch"} ${output.label} (${result.status})`
                            : `GPIO: ${result.message}`,
                    error: true,
                });
            }
        });
    };

    return (
        <div className="dlg-row wrap" data-testid={`gpio-${output.name}`}>
            <span className="dlg-label dlg-grow" id={labelId}>
                {output.label}
            </span>
            {output.note ? <span className="dlg-hint">{output.note}</span> : null}
            <span className="dlg-inline-actions">
                {/* Pulse first, switch last: a column of states reads down only if they share an edge. */}
                {output.canPulse ? (
                    <Btn
                        aria-label={`Pulse ${output.label}`}
                        aria-disabled={inFlight}
                        disabled={unavailable}
                        onClick={() => void act("pulse")}
                    >
                        Pulse
                    </Btn>
                ) : null}
                {output.canSwitch ? (
                    <Btn
                        role="switch"
                        aria-checked={output.on}
                        aria-labelledby={labelId}
                        aria-disabled={inFlight}
                        disabled={unavailable}
                        onClick={() => void act("switch")}
                    >
                        {output.on ? "On" : "Off"}
                    </Btn>
                ) : null}
            </span>
        </div>
    );
}

export function HealthDialog({ session, onClose }: DialogProps) {
    const device = useTarget((s) => s.device);
    const link = useTarget((s) => s.link);
    const confirm = useConfirm();
    const pending = usePending();

    const problems = healthProblems({ device, everSettled: link.everSettled, inputOpen: link.open });
    const summary = healthSummary(problems, anythingReported(device));
    const hid = hidView(device.hid);
    const atx = atxView(device.atx);
    const outputs = gpioOutputs(device.gpio);
    const about = aboutLine(device.info);
    const msdPresent = !!device.msd?.enabled;

    const setAttached = async (attach: boolean): Promise<void> => {
        await pending.run("hid", async () => {
            const result = await kvmdPost(session, `/api/hid/set_connected?connected=${attach ? 1 : 0}`);
            // Present tense: a 200 is kvmd taking the request; the hid event reports what happened.
            session.notices.notify(
                result.ok
                    ? { text: attach ? "Attaching the keyboard and mouse" : "Detaching the keyboard and mouse" }
                    : {
                          text: failureLine(`${attach ? "attach" : "detach"} the keyboard and mouse`, result),
                          error: true,
                      },
            );
        });
    };

    const resetHid = async (): Promise<void> => {
        const ok = await confirm.ask({
            title: "Reset the keyboard and mouse?",
            body: "The target briefly sees the USB device disappear and come back.",
            confirm: "Reset",
        });
        if (!ok) return;
        const result = await kvmdPost(session, "/api/hid/reset");
        session.notices.notify(
            result.ok
                ? { text: "Keyboard and mouse reset" }
                : { text: failureLine("reset the keyboard and mouse", result), error: true },
        );
    };

    const pressPower = async (button: AtxButton): Promise<void> => {
        const ok = await confirm.ask({ ...ATX_COPY[button], danger: true });
        if (!ok) return;
        await pending.run("atx", async () => {
            const failure = await pressAtx(session, button);
            if (failure) session.notices.notify({ text: failure, error: true });
        });
    };

    return (
        <>
            <DialogShell
                title="System"
                onClose={onClose}
                testId="health-dialog"
                initialFocus="[data-done]"
                actions={
                    <Btn variant="primary" data-done="" onClick={onClose}>
                        Done
                    </Btn>
                }
            >
                {problems.length > 0 ? (
                    <ul className="dlg-list" aria-label="Problems">
                        {problems.map((p) => (
                            <li
                                key={`${p.level}:${p.text}`}
                                className={p.level === "error" ? "is-error" : undefined}
                                aria-label={`${p.level === "error" ? "Error" : "Warning"}: ${p.text}`}
                            >
                                {p.text}
                            </li>
                        ))}
                    </ul>
                ) : null}
                {summary ? <Note>{summary}</Note> : null}

                {atx.available ? (
                    <>
                        <Rule />
                        <div className="dlg-section" data-testid="atx-section">
                            <h3 className="dlg-section-title">Power</h3>
                            <div className="dlg-row wrap">
                                <span className="dlg-led" data-on={atx.powered === true} data-testid="atx-power-led">
                                    {atx.powered === null ? "Power unknown" : atx.powered ? "Power on" : "Power off"}
                                </span>
                                {atx.hdd !== null ? (
                                    <span className="dlg-led" data-on={atx.hdd}>
                                        {atx.hdd ? "Drive active" : "Drive idle"}
                                    </span>
                                ) : null}
                                {atx.busy ? <span className="dlg-hint">busy</span> : null}
                            </div>
                            <div className="dlg-inline-actions" style={{ flexWrap: "wrap" }}>
                                {(["power", "power_long", "reset"] as const).map((button) => (
                                    <Btn
                                        key={button}
                                        disabled={atx.busy}
                                        aria-disabled={pending.has("atx")}
                                        onClick={() => void pressPower(button)}
                                    >
                                        {ATX_COPY[button].label}
                                    </Btn>
                                ))}
                            </div>
                        </div>
                    </>
                ) : null}

                {msdPresent ? (
                    <>
                        <Rule />
                        <div className="dlg-section">
                            <h3 className="dlg-section-title">Mass storage</h3>
                            <p className="dlg-note" data-testid="msd-state">
                                {msdSummary(device.msd)}
                            </p>
                            <div className="dlg-inline-actions">
                                <Btn onClick={() => session.dialogs.open("msd")}>Open mass storage</Btn>
                            </div>
                        </div>
                    </>
                ) : null}

                {outputs.length > 0 ? (
                    <>
                        <Rule />
                        <div className="dlg-section" data-testid="gpio-section">
                            <h3 className="dlg-section-title">GPIO</h3>
                            {outputs.map((o) => (
                                <GpioRow key={o.name} output={o} pending={pending} session={session} confirm={confirm} />
                            ))}
                        </div>
                    </>
                ) : null}

                <Rule />
                <div className="dlg-section">
                    <div className="dlg-row wrap">
                        <span className="dlg-label">Keyboard and mouse</span>
                        <span className="dlg-hint" data-testid="hid-state">
                            {hid.text}
                        </span>
                    </div>
                    <div className="dlg-inline-actions">
                        <Btn
                            disabled={!hid.known || hid.busy}
                            aria-disabled={pending.has("hid")}
                            onClick={() => void setAttached(!hid.attached)}
                        >
                            {hid.attached ? "Detach" : "Attach"}
                        </Btn>
                        {/* Stays live while busy: the recovery lever for a keyboard the target stopped answering. */}
                        <Btn onClick={() => void resetHid()}>Reset</Btn>
                    </div>
                </div>
                {about ? (
                    <p className="dlg-note dlg-about" data-testid="about-line">
                        {about}
                    </p>
                ) : null}
            </DialogShell>
            {confirm.element}
        </>
    );
}
