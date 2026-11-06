/**
 * Settings -> Notifications: the server-side watch for pop-ups.
 *
 * The server looks at one corner of the PiKVM's screen on its own, with no browser open; when a pop-up appears it reads it on the
 * server and, when the person has a chat model, that model decides whether it is worth interrupting them for and writes the notification
 * before a Web Push goes to the devices that subscribed. This page switches that on, says where pop-ups appear, says what is notified
 * and what is not, holds the person's extra instructions, subscribes THIS device, sends a test, and shows the check log so a
 * notification that did not come can be explained.
 *
 * On an iPhone it only works from the app added to the Home Screen, and the permission prompt must come from the tap
 * that switches it on (see device.ts and push-client.ts).
 */

import { ALERT_ZONES, alertZoneId, type CheckEntry, type JudgeReason, type ModelFailure, type WatchView } from "@pikvm/contracts/watch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { describeDevice, readDeviceEnv, type DeviceState } from "../../notify/device";
import { currentSubscription, subscribeThisDevice, unsubscribeThisDevice } from "../../notify/push-client";
import {
    getChecks,
    getWatch,
    patchWatch,
    sendTestNotification,
    subscribeDevice,
    unsubscribeDevice,
    WatchApiError,
} from "../../notify/watch-api";
import {
    Button,
    Notice,
    Select,
    SettingRow,
    SettingsCard,
    SettingsPage,
    SettingsSection,
    Switch,
    TextArea,
} from "@pikvm/chat-web/settings";
import { LoadError } from "./load-error";

const watchKey = ["watch"] as const;
const checksKey = ["watch", "checks"] as const;

/** How the log names what happened. */
const OUTCOME: Record<CheckEntry["outcome"], string> = {
    pushed: "Notified you",
    no: "Not urgent",
    held: "Held back",
    skipped: "Nothing sent",
    error: "Failed",
};

/** The judge's reasons as plain labels. The log never holds the pop-up's words, so this is all it can say about one. */
const REASON: Record<JudgeReason, string> = {
    call: "a call",
    person_waiting: "a person is waiting",
    time_critical: "starts soon",
    security: "a sign-in or security request",
    failure: "something failed",
    money_legal: "money or a deadline",
    real_world: "an alarm or a door alert",
    routine: "routine status",
    marketing_social: "marketing or social activity",
    chatter: "group chatter or a bot",
    duplicate: "a repeat",
    rule: "your extra instructions",
    other: "nothing that needs you",
};

/** What a step of the chat model did when it gave nothing usable. A step is only given up on after a long wait (two minutes), so this is a model that is not answering. */
const FAILURE: Record<ModelFailure, string> = {
    timeout: "the chat model did not answer",
    error: "the chat model failed",
    invalid: "the chat model gave an answer that could not be used",
    empty: "the chat model gave an empty answer",
};

/** The choice a stored rectangle that is none of the presets shows as; it cannot be picked, only kept. */
const CUSTOM_ZONE = "custom";

const message = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong.");

function formatTime(t: number): string {
    return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function checkSummary(entry: CheckEntry): string {
    const what = entry.kind === "test" ? "Test notification" : "Pop-up in the corner";
    const judged = entry.judged;
    if (entry.outcome === "no" && judged?.reason) return `${what}: ${REASON[judged.reason]}`;
    const detail = entry.reason ?? entry.description ?? "";
    // The log never holds the pop-up's words, so say what kind of notification it was and how long it took instead.
    const seconds = entry.latency?.totalMs !== undefined ? `${(entry.latency.totalMs / 1000).toFixed(1)} seconds to send` : "";
    const steps = judged
        ? [
              judged.notify && judged.reason ? REASON[judged.reason] : "",
              judged.readSkipped ? `${FAILURE[judged.readSkipped]} while reading` : "",
              judged.judgeSkipped ? `${FAILURE[judged.judgeSkipped]} while judging, so it was sent as read` : "",
          ]
        : [];
    const facts = entry.kind === "alert" ? [entry.notified?.urgency === "high" ? "urgent" : entry.notified ? "a pop-up" : "", ...steps, seconds].filter(Boolean).join(", ") : "";
    return `${what}${detail ? `: ${detail}` : facts ? `: ${facts}` : ""}`;
}

export function NotificationsPage() {
    const queryClient = useQueryClient();
    const view = useQuery<WatchView, WatchApiError>({
        queryKey: watchKey,
        queryFn: ({ signal }) => getWatch(signal),
        refetchInterval: 10_000,
    });
    const checks = useQuery({
        queryKey: checksKey,
        queryFn: ({ signal }) => getChecks(8, signal),
        refetchInterval: 10_000,
    });
    const save = useMutation<WatchView, WatchApiError, Parameters<typeof patchWatch>[0]>({
        mutationFn: patchWatch,
        onSuccess: (next) => queryClient.setQueryData(watchKey, next),
    });

    const [device, setDevice] = useState<DeviceState>(() => describeDevice(readDeviceEnv()));
    const [subscribed, setSubscribed] = useState<boolean | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState("");
    const [note, setNote] = useState("");
    // Which switch was used last: the problem and a failed save are shown on that row, not on both.
    const [lastUsed, setLastUsed] = useState<"agent" | "watch">("watch");

    const refreshDevice = async () => {
        const next = describeDevice(readDeviceEnv());
        setDevice(next);
        setSubscribed(next.kind === "ready" && (await currentSubscription().catch(() => null)) !== null);
    };

    // What this device is, once; and again after anything that changes it.
    useEffect(() => {
        void refreshDevice();
    }, []);

    // A device that was subscribed keeps the server's copy of its subscription current: the server may have dropped it
    // (an expired one is removed) or the browser may have rotated it.
    const publicKey = view.data?.push.publicKey;
    const wanted = view.data?.enabled === true || view.data?.notifyAgent === true;
    useEffect(() => {
        if (!wanted || !publicKey || device.kind !== "ready" || device.permission !== "granted") return;
        let cancelled = false;
        void (async () => {
            try {
                const sub = await subscribeThisDevice(publicKey);
                if (!cancelled) await subscribeDevice(sub.toJSON());
                if (!cancelled) setSubscribed(true);
            } catch {
                /* the page says nothing: the switch and the test button report real failures */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [wanted, publicKey, device]);

    const [rule, setRule] = useState<string | undefined>(undefined);

    if (view.isError) {
        return (
            <SettingsPage title="Notifications">
                <LoadError message={view.error.message} onRetry={() => void view.refetch()} />
            </SettingsPage>
        );
    }
    const data = view.data;

    const shownRule = rule ?? data?.rule ?? "";
    const dirty = data !== undefined && shownRule.trim() !== data.rule;
    const cannotEnable = data !== undefined && !data.canEnable.ok ? data.canEnable.reason : "";
    const deviceBlocked = device.kind === "ready" ? "" : device.message;
    const on = data?.enabled === true;

    /**
     * Asks for the permission and subscribes this device. The prompt must come from the tap that got us here, so nothing is awaited before it.
     * Says why and answers false when it cannot.
     */
    const setUpDevice = async (): Promise<boolean> => {
        setProblem("");
        setNote("");
        if (!data) return false;
        const permission = device.kind === "ready" && device.permission === "default" ? await Notification.requestPermission() : undefined;
        setBusy(true);
        try {
            if (device.kind !== "ready") throw new Error(device.message);
            if (permission === "denied") {
                await refreshDevice();
                throw new Error("Notifications are blocked on this device. Allow them, then try again.");
            }
            if (!data.push.available || !data.push.publicKey) throw new Error(data.push.reason ?? "The server cannot send notifications.");
            const sub = await subscribeThisDevice(data.push.publicKey);
            await subscribeDevice(sub.toJSON());
            await refreshDevice();
            void queryClient.invalidateQueries({ queryKey: watchKey });
            return true;
        } catch (error) {
            setProblem(message(error));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const toggle = async (next: boolean) => {
        setLastUsed("watch");
        if (!data) return;
        if (!next) {
            setProblem("");
            setNote("");
            save.mutate({ enabled: false });
            return;
        }
        if (await setUpDevice()) save.mutate({ enabled: true });
    };

    const toggleAgent = async (next: boolean) => {
        setLastUsed("agent");
        if (!data) return;
        if (!next) {
            setProblem("");
            setNote("");
            save.mutate({ notifyAgent: false });
            return;
        }
        // With a device already set up (this one or another) there is nothing to ask of this browser.
        if (data.push.subscriptions === 0 && subscribed !== true && !(await setUpDevice())) return;
        save.mutate({ notifyAgent: true });
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        save.mutate({ rule: shownRule }, { onSuccess: () => setRule(undefined) });
    };

    const test = async () => {
        setProblem("");
        setNote("");
        setBusy(true);
        try {
            const result = await sendTestNotification();
            setNote(
                result.sent > 0
                    ? `Sent to ${result.sent} device${result.sent === 1 ? "" : "s"}.${result.removed ? ` ${result.removed} expired device${result.removed === 1 ? " was" : "s were"} removed.` : ""}`
                    : "No device could be reached.",
            );
            void queryClient.invalidateQueries({ queryKey: watchKey });
            void queryClient.invalidateQueries({ queryKey: checksKey });
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    };

    const forgetDevice = async () => {
        setProblem("");
        setNote("");
        setBusy(true);
        try {
            const endpoint = await unsubscribeThisDevice();
            if (endpoint) await unsubscribeDevice(endpoint);
            await refreshDevice();
            void queryClient.invalidateQueries({ queryKey: watchKey });
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    };

    const limits = data?.limits;
    const zoneChoice = data ? (alertZoneId(data.alertZone) ?? CUSTOM_ZONE) : ALERT_ZONES[0].id;
    return (
        <SettingsPage
            title="Notifications"
            description="Get a notification when the agent needs you, or when a pop-up appears on the target's screen, even while the app is closed."
        >
            <SettingsSection
                title="The agent"
                description="The agent stops and waits for you when it needs an approval, an answer or some information. The notification says that and nothing about what it wants to do. It is not sent while you are using the app."
            >
                <SettingsCard>
                    <SettingRow
                        id="notify-agent"
                        label="Notify me when the agent needs me"
                        description={
                            data && data.notifyAgent && data.push.subscriptions === 0 && subscribed !== true
                                ? "On, but no device is set up yet. Set up this device below."
                                : "Also while the app is closed."
                        }
                        status={busy || save.isPending ? { state: "saving" } : { state: "idle" }}
                        error={lastUsed === "agent" ? problem || (save.error ? `Could not save: ${save.error.message}` : null) : null}
                        control={
                            <Switch
                                label="Notify me when the agent needs me"
                                checked={data?.notifyAgent === true}
                                disabled={!data || busy || save.isPending || (data.notifyAgent !== true && data.push.subscriptions === 0 && subscribed !== true && deviceBlocked !== "")}
                                onChange={(next) => void toggleAgent(next)}
                            />
                        }
                    />
                </SettingsCard>
            </SettingsSection>

            <SettingsSection
                title="Pop-ups"
                description={
                    limits && data
                        ? `The server looks at the corner you choose every ${limits.intervalSec === 1 ? "second" : `${limits.intervalSec} seconds`}, even when no app is open, and reads a pop-up on the server as soon as it has stayed for ${limits.settleSec} seconds. Limits: one check every ${limits.minCheckGapSec} seconds and ${limits.dailyCap} a day (${limits.askedToday} used in the last 24 hours).`
                        : "Loading"
                }
            >
                <SettingsCard>
                    <SettingRow
                        id="screen-watch"
                        label="Notify me about pop-ups"
                        description="Also while the app is closed. Notifications are held back while you are using this window."
                        status={busy || save.isPending ? { state: "saving" } : { state: "idle" }}
                        error={lastUsed === "watch" ? problem || (save.error ? `Could not save: ${save.error.message}` : null) : null}
                        control={
                            <Switch
                                label="Notify me about pop-ups"
                                checked={on}
                                disabled={!data || busy || save.isPending || (!on && (cannotEnable !== "" || deviceBlocked !== ""))}
                                onChange={(next) => void toggle(next)}
                            />
                        }
                    />
                    {!on && cannotEnable ? <SettingRow label="Not available yet" description={cannotEnable} /> : null}
                    {!on && !cannotEnable && deviceBlocked ? (
                        <SettingRow label="Not available on this device" description={deviceBlocked} />
                    ) : null}
                    {on && data ? (
                        <SettingRow
                            label={data.running ? (data.signal === "no-signal" ? "Watching, no video signal" : "Watching the screen") : "Not watching"}
                            description={data.running ? "The server is looking at the screen now." : "The server is not running the watch. Switch it off and on again."}
                        />
                    ) : null}
                    {busy && !on ? (
                        <SettingRow
                            label="Setting up this device"
                            description="Requesting a push subscription from this device. This can take a few seconds."
                        />
                    ) : null}
                    <SettingRow
                        id="alert-zone"
                        label="Where pop-ups appear"
                        description="The corner of the screen to watch."
                        control={
                            <Select
                                label="Where pop-ups appear"
                                value={zoneChoice}
                                disabled={!data || save.isPending}
                                options={[...ALERT_ZONES.map((preset) => ({ value: preset.id, label: preset.label })), ...(zoneChoice === CUSTOM_ZONE ? [{ value: CUSTOM_ZONE, label: "Custom area" }] : [])]}
                                onChange={(id) => {
                                    const preset = ALERT_ZONES.find((each) => each.id === id);
                                    if (preset) save.mutate({ alertZone: { ...preset.zone } });
                                }}
                            />
                        }
                    />
                    {data ? (
                        <SettingRow
                            label="How notifications are decided"
                            description={
                                data.chatModel
                                    ? "The text read from the pop-up (not the picture) goes to your chat model. It reads the text and decides whether it is worth interrupting you for."
                                    : "No chat model is configured, so every pop-up is sent as read."
                            }
                        />
                    ) : null}
                </SettingsCard>
            </SettingsSection>

            <form onSubmit={submit} className="contents">
                <SettingsSection
                    title="What is worth a notification"
                    description={
                        data?.chatModel === false
                            ? "Without a chat model every pop-up is sent, and extra instructions cannot be applied."
                            : "You are notified when you are needed now or within minutes."
                    }
                >
                    <SettingsCard>
                        <SettingRow
                            label="Notified by default"
                            description="Calls. People waiting for a reply. Things that start in minutes. Sign-in requests and codes. Failures and outages. Deadlines and money. Alarms and door alerts."
                        />
                        <SettingRow
                            label="Not notified by default"
                            description="Marketing. Likes, follows and posts. Routine status, such as updates and finished backups. Group chatter and bot messages. Repeats."
                        />
                        <SettingRow
                            id="watch-rule"
                            label="Extra instructions"
                            description="Add what else matters, or what to ignore. Sign-in requests stay on unless you name them."
                            stack
                            control={
                                <TextArea
                                    label="Extra instructions"
                                    rows={3}
                                    maxLength={500}
                                    placeholder="For example: also tell me about the build server. Ignore anything about the news."
                                    value={shownRule}
                                    disabled={!data}
                                    onChange={setRule}
                                />
                            }
                        />
                    </SettingsCard>
                    <div className="flex justify-end">
                        <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
                            Save
                        </Button>
                    </div>
                </SettingsSection>
            </form>

            <SettingsSection
                title="This device"
                description={device.kind === "ready" ? "A test notification goes to every device that switched this on." : undefined}
            >
                <SettingsCard>
                    {device.kind === "ready" ? (
                        <SettingRow
                            label={subscribed ? "This device is set up" : "This device is not set up"}
                            description={subscribed ? "It will receive notifications." : "Set it up here, or switch one of the notifications above on."}
                            control={
                                subscribed ? undefined : (
                                    <Button variant="primary" disabled={busy || !data} onClick={() => void setUpDevice()}>
                                        Set up this device
                                    </Button>
                                )
                            }
                        />
                    ) : (
                        <SettingRow label="Not available on this device" description={device.message} />
                    )}
                    <SettingRow
                        label="Send test notification"
                        description={data && data.push.subscriptions === 0 ? "No device has been set up yet." : undefined}
                        control={
                            <Button disabled={busy || !data || data.push.subscriptions === 0} onClick={() => void test()}>
                                Send test notification
                            </Button>
                        }
                    />
                    {subscribed ? (
                        <SettingRow
                            label="Stop notifying this device"
                            control={
                                <Button disabled={busy} onClick={() => void forgetDevice()}>
                                    Remove this device
                                </Button>
                            }
                        />
                    ) : null}
                </SettingsCard>
                {note ? <Notice tone="success">{note}</Notice> : null}
            </SettingsSection>

            <SettingsSection
                title="Recent checks"
                description="Newest first. The log says what happened and how long it took, not what the pop-up said."
            >
                <SettingsCard>
                    {checks.data && checks.data.checks.length > 0 ? (
                        checks.data.checks.map((entry) => (
                            <SettingRow
                                key={entry.t}
                                label={`${OUTCOME[entry.outcome]}, ${formatTime(entry.t)}`}
                                description={checkSummary(entry)}
                            />
                        ))
                    ) : (
                        <SettingRow label="Nothing yet" description="A check is made when a pop-up appears and stays." />
                    )}
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
