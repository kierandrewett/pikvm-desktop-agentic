/**
 * Settings -> YouTube: the host uploads each finished recording to a YouTube channel, when auto-upload is on.
 *
 * The person signs in once with a device code (type the code at Google's device page) and gives the OAuth client id and
 * secret the host uses. The secret is write-only: the page only learns whether one is set. Turning auto-upload on says plainly
 * that earlier recordings are not uploaded unless "also upload existing" is on; the Existing recordings section queues them.
 * Server: src/server/recordings/youtube/.
 */

import { YOUTUBE_PRIVACY, type YouTubePrivacy, type YouTubeSettings } from "@pikvm/contracts/recordings";
import { Button, Input, Notice, Select, SettingRow, SettingsCard, SettingsPage, SettingsSection, Switch } from "@pikvm/chat-web/settings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { YOUTUBE_PATH, youtubeKey, readYouTubeSettings, request } from "../../recordings/youtube-api";
import { LoadError } from "./load-error";

const PRIVACY_LABEL: Record<YouTubePrivacy, string> = {
    private: "Private (only you)",
    unlisted: "Unlisted (anyone with the link)",
    public: "Public",
};

export function YouTubePage() {
    const queryClient = useQueryClient();
    const view = useQuery<YouTubeSettings, Error>({
        queryKey: youtubeKey,
        queryFn: readYouTubeSettings,
        // A sign-in or backfill runs at Google and in the background: keep reading until it lands.
        refetchInterval: (query) => {
            const backfill = query.state.data?.backfill;
            const backfilling = backfill !== undefined && backfill.uploaded + backfill.failed < backfill.total;
            return query.state.data?.pending || backfilling ? 3_000 : false;
        },
    });
    const update = useMutation<YouTubeSettings, Error, Record<string, unknown>>({
        mutationFn: (body) => request<YouTubeSettings>("PATCH", YOUTUBE_PATH, body),
        onSuccess: (next) => queryClient.setQueryData(youtubeKey, next),
    });
    const connect = useMutation<YouTubeSettings, Error, void>({
        mutationFn: () => request<YouTubeSettings>("POST", `${YOUTUBE_PATH}/connect`),
        onSuccess: (next) => queryClient.setQueryData(youtubeKey, next),
    });
    const disconnect = useMutation<YouTubeSettings, Error, void>({
        mutationFn: () => request<YouTubeSettings>("POST", `${YOUTUBE_PATH}/disconnect`),
        onSuccess: (next) => queryClient.setQueryData(youtubeKey, next),
    });
    const backfill = useMutation<YouTubeSettings, Error, void>({
        mutationFn: () => request<YouTubeSettings>("POST", `${YOUTUBE_PATH}/backfill`),
        onSuccess: (next) => queryClient.setQueryData(youtubeKey, next),
    });

    // The form's own edits; null means "show what the host has".
    const [clientId, setClientId] = useState<string | null>(null);
    const [clientSecret, setClientSecret] = useState("");
    const [saved, setSaved] = useState<string | null>(null);

    if (view.isError) return <LoadError message={view.error.message} onRetry={() => void view.refetch()} />;
    const data = view.data;
    if (!data) return null;

    const busy = update.isPending || connect.isPending || disconnect.isPending || backfill.isPending;
    const failure = (update.error ?? connect.error ?? disconnect.error ?? backfill.error ?? null)?.message ?? null;
    const idShown = clientId ?? data.clientId ?? "";

    const toggleAuto = (next: boolean): void => {
        setSaved(null);
        update.mutate({ autoUpload: next }, { onSuccess: () => setSaved(next ? "Auto-upload is on." : "Auto-upload is off.") });
    };

    const saveCredentials = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        setSaved(null);
        const body: Record<string, unknown> = { clientId: idShown.trim() === "" ? null : idShown.trim() };
        // The secret is write-only: an empty box keeps the stored one.
        if (clientSecret !== "") body.clientSecret = clientSecret;
        update.mutate(body, {
            onSuccess: () => {
                setClientSecret("");
                setClientId(null);
                setSaved("Saved.");
            },
        });
    };

    return (
        <SettingsPage title="YouTube" description="Upload each finished recording to a YouTube channel.">
            <SettingsSection
                title="Automatic upload"
                description="A recording is uploaded once it is finished, and YouTube has confirmed it before it is marked uploaded."
            >
                <SettingsCard>
                    <SettingRow
                        id="youtube-auto"
                        label="Upload finished recordings automatically"
                        description={
                            data.autoUploadSince
                                ? `Recordings finished since ${new Date(data.autoUploadSince).toLocaleString()} are uploaded.${data.backfillOnEnable ? " Existing ones are queued too." : " Earlier ones are not."}`
                                : data.backfillOnEnable
                                  ? "Turning this on also uploads the existing recordings, oldest first."
                                  : "Turning this on uploads only recordings finished from then on. Earlier recordings are not uploaded."
                        }
                        status={busy ? { state: "saving" } : { state: "idle" }}
                        control={
                            <Switch
                                label="Upload finished recordings automatically"
                                checked={data.autoUpload}
                                disabled={busy || !data.connected || !data.clientId}
                                onChange={toggleAuto}
                            />
                        }
                    />
                    {!data.connected || !data.clientId ? (
                        <SettingRow label="Needs a sign-in" description="Save the client id and secret and sign in below before turning this on." />
                    ) : null}
                    <SettingRow
                        id="youtube-backfill-on-enable"
                        label="Also upload existing recordings when auto-upload is turned on"
                        description="Off by default, so turning auto-upload on never spends quota on old recordings unless you ask."
                        control={
                            <Switch
                                label="Also upload existing recordings when auto-upload is turned on"
                                checked={data.backfillOnEnable}
                                disabled={busy}
                                onChange={(next) => update.mutate({ backfillOnEnable: next })}
                            />
                        }
                    />
                    <SettingRow
                        id="youtube-privacy"
                        label="Privacy"
                        description="The privacy each upload is given. You can change it on YouTube afterwards."
                        control={
                            <Select<YouTubePrivacy>
                                label="Privacy of uploaded videos"
                                value={data.privacy}
                                disabled={busy}
                                options={YOUTUBE_PRIVACY.map((value) => ({ value, label: PRIVACY_LABEL[value] }))}
                                onChange={(privacy) => update.mutate({ privacy })}
                            />
                        }
                    />
                </SettingsCard>
            </SettingsSection>

            <SettingsSection
                title="Existing recordings"
                description="Uploads the finished recordings YouTube does not have yet, oldest first. Google's default allows 100 uploads a day, so a large backlog takes days."
            >
                <SettingsCard>
                    <SettingRow
                        id="youtube-backfill"
                        label="Not uploaded yet"
                        description={`${data.backfill.eligible} finished recording${data.backfill.eligible === 1 ? "" : "s"} not on YouTube.`}
                        status={busy ? { state: "saving" } : { state: "idle" }}
                        control={
                            <Button disabled={busy || !data.connected || data.backfill.eligible === 0} onClick={() => backfill.mutate()}>
                                Upload existing recordings
                            </Button>
                        }
                    />
                    {data.backfill.total > 0 ? (
                        <SettingRow
                            label="Progress"
                            description={`${data.backfill.uploaded} of ${data.backfill.total} uploaded, ${data.backfill.waitingForQuota} waiting for quota${data.backfill.failed > 0 ? `, ${data.backfill.failed} failed` : ""}.`}
                        />
                    ) : null}
                </SettingsCard>
            </SettingsSection>

            <SettingsSection
                title="Account"
                description="The YouTube channel this host uploads to. Sign in once; the host keeps the sign-in until you disconnect."
            >
                <SettingsCard>
                    {data.pending ? (
                        <SettingRow
                            id="youtube-sign-in"
                            label="Enter this code at Google"
                            description={`Open ${data.pending.verificationUrl} on any device and type the code. It expires ${new Date(data.pending.expiresAt).toLocaleTimeString()}.`}
                            hint={`Code: ${data.pending.userCode}`}
                        />
                    ) : null}
                    <SettingRow
                        label={data.connected ? "Signed in" : "Not signed in"}
                        description={data.connected ? "The host can upload to this channel." : "Needs the client id and secret below."}
                        control={
                            data.connected ? (
                                <Button variant="danger" disabled={busy} onClick={() => disconnect.mutate()}>
                                    Disconnect
                                </Button>
                            ) : (
                                <Button disabled={busy || !data.clientId || !data.clientSecretSet} onClick={() => connect.mutate()}>
                                    Sign in to YouTube
                                </Button>
                            )
                        }
                    />
                </SettingsCard>
            </SettingsSection>

            <SettingsSection
                title="Google OAuth client"
                description="From Google Cloud: an OAuth client of the type TVs and Limited Input devices, with the YouTube Data API v3 enabled."
            >
                <form onSubmit={saveCredentials}>
                    <SettingsCard>
                        <SettingRow
                            label="Client id"
                            control={
                                <Input
                                    aria-label="Client id"
                                    value={idShown}
                                    disabled={busy}
                                    autoComplete="off"
                                    onChange={(event) => setClientId(event.target.value)}
                                />
                            }
                        />
                        <SettingRow
                            label="Client secret"
                            description={
                                data.clientSecretSet
                                    ? "A secret is saved. Type a new one to replace it; it is never shown again."
                                    : "Not set."
                            }
                            control={
                                <Input
                                    aria-label="Client secret"
                                    type="password"
                                    value={clientSecret}
                                    placeholder={data.clientSecretSet ? "(saved)" : ""}
                                    disabled={busy}
                                    autoComplete="new-password"
                                    onChange={(event) => setClientSecret(event.target.value)}
                                />
                            }
                        />
                        <SettingRow
                            label="Save"
                            control={
                                <Button type="submit" variant="primary" disabled={busy}>
                                    Save
                                </Button>
                            }
                        />
                    </SettingsCard>
                </form>
            </SettingsSection>

            {failure ? <Notice tone="danger">{`Could not save: ${failure}`}</Notice> : null}
            {!failure && data.lastError ? <Notice tone="danger">{data.lastError}</Notice> : null}
            {!failure && !data.lastError && saved ? <Notice tone="success">{saved}</Notice> : null}
            {data.quotaResumeAt ? (
                <Notice tone="warning">{`Paused: daily YouTube quota used, resumes at ${new Date(data.quotaResumeAt).toLocaleString()}.`}</Notice>
            ) : null}
        </SettingsPage>
    );
}
