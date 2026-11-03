/**
 * Settings -> Notifications: the server-side screen watch.
 *
 * The server looks at the PiKVM's screen on its own, with no browser open; when it changes and settles, an image model
 * reads it, a decision model judges it against the rule typed here, and a yes becomes a Web Push to the devices that
 * subscribed. This page switches that on, holds the rule and the model, subscribes THIS device, sends a test, and shows
 * the check log so a notification that did not come can be explained.
 *
 * On an iPhone it only works from the app added to the Home Screen, and the permission prompt must come from the tap
 * that switches it on (see device.ts and push-client.ts).
 */

import type { CheckEntry, WatchView } from "@pikvm/contracts/watch";
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
    SettingRow,
    SettingsCard,
    SettingsPage,
    SettingsSection,
    Switch,
    TextArea,
    TextField,
} from "@pikvm/chat-web/settings";
import { LoadError } from "./load-error";

const watchKey = ["watch"] as const;
const checksKey = ["watch", "checks"] as const;

/** How the log names what happened. */
const OUTCOME: Record<CheckEntry["outcome"], string> = {
    pushed: "Notified you",
    no: "Not important",
    undecided: "Not sure, nothing sent",
    skipped: "Not checked",
    error: "Failed",
};

const message = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong.");

function formatTime(t: number): string {
    return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function checkSummary(entry: CheckEntry): string {
    const detail = entry.reason ?? entry.description ?? "";
    const what = entry.kind === "test" ? "Test notification" : entry.kind === "signal-lost" ? "Video signal lost" : "Screen changed";
    return `${what}${detail ? `: ${detail}` : ""}`;
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
    const wanted = view.data?.enabled === true;
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
    const [model, setModel] = useState<string | undefined>(undefined);

    if (view.isError) {
        return (
            <SettingsPage title="Notifications">
                <LoadError message={view.error.message} onRetry={() => void view.refetch()} />
            </SettingsPage>
        );
    }
    const data = view.data;

    const shownRule = rule ?? data?.rule ?? "";
    const shownModel = model ?? data?.visionModel ?? "";
    const dirty = data !== undefined && (shownRule.trim() !== data.rule || shownModel.trim() !== data.visionModel);
    const cannotEnable = data !== undefined && !data.canEnable.ok ? data.canEnable.reason : "";
    const deviceBlocked = device.kind === "ready" ? "" : device.message;
    const on = data?.enabled === true;

    const toggle = async (next: boolean) => {
        setProblem("");
        setNote("");
        if (!data) return;
        if (!next) {
            save.mutate({ enabled: false });
            return;
        }
        // Asked first and synchronously: the prompt must come from this tap, before any await.
        const permission = device.kind === "ready" && device.permission === "default" ? await Notification.requestPermission() : undefined;
        setBusy(true);
        try {
            if (device.kind !== "ready") throw new Error(device.message);
            if (permission === "denied") {
                await refreshDevice();
                throw new Error("Notifications are blocked on this device. Allow them, then switch this on again.");
            }
            if (!data.push.available || !data.push.publicKey) throw new Error(data.push.reason ?? "The server cannot send notifications.");
            const sub = await subscribeThisDevice(data.push.publicKey);
            await subscribeDevice(sub.toJSON());
            save.mutate({ enabled: true });
            await refreshDevice();
        } catch (error) {
            setProblem(message(error));
        } finally {
            setBusy(false);
        }
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        save.mutate({ rule: shownRule, visionModel: shownModel }, { onSuccess: () => { setRule(undefined); setModel(undefined); } });
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
    return (
        <SettingsPage
            title="Notifications"
            description="Hear about changes on the target's screen, even while the app is closed."
        >
            <SettingsSection
                title="Screen watch"
                description={
                    limits && data
                        ? `The server checks the screen every ${limits.intervalSec} seconds, even when no app is open. When the screen changes and stays still for ${limits.settleSec} seconds, an image model describes it. A decision model then judges the description against your rule. Only a clear yes sends a notification. Limits: one check ${limits.minCheckGapSec === 60 ? "a minute" : `every ${limits.minCheckGapSec} seconds`} and ${limits.dailyCap} a day (${limits.askedToday} used in the last 24 hours). Checks use your OpenRouter key and cost a fraction of a cent each.`
                        : "Loading"
                }
            >
                <SettingsCard>
                    <SettingRow
                        id="screen-watch"
                        label="Notify me when the screen changes"
                        description="Also while the app is closed."
                        status={busy || save.isPending ? { state: "saving" } : { state: "idle" }}
                        error={problem || (save.error ? `Could not save: ${save.error.message}` : null)}
                        control={
                            <Switch
                                label="Notify me when the screen changes"
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
                </SettingsCard>
            </SettingsSection>

            <form onSubmit={submit} className="contents">
                <SettingsSection
                    title="What to tell me about"
                    description="Describe what matters in your own words. For example: tell me when the install finishes or an error shows. Leave it empty to hear about anything important, such as a dialog, an error, a finished or failed task, or a restart."
                >
                    <SettingsCard>
                        <SettingRow id="watch-rule" label="Rule" stack control={
                            <TextArea
                                label="Rule"
                                rows={3}
                                maxLength={500}
                                value={shownRule}
                                disabled={!data}
                                onChange={setRule}
                            />
                        } />
                        <SettingRow
                            id="watch-model"
                            label="Image model"
                            description={`Describes each settled screen in a sentence or two. Any OpenRouter model that accepts images works. Leave it empty to use ${data?.defaultVisionModel ?? "the default"}.`}
                            stack
                            control={
                                <TextField
                                    label="Image model"
                                    value={shownModel}
                                    placeholder={data?.defaultVisionModel ?? ""}
                                    disabled={!data}
                                    onChange={setModel}
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
                            description={subscribed ? "It will receive notifications." : "Switch the watch on to set it up."}
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
                description="Newest first. The server log also keeps each description and decision."
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
                        <SettingRow label="Nothing yet" description="A check is made when the screen changes and settles." />
                    )}
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
