import type { PikvmTarget } from "@pikvm/contracts/api";
import { useAppState } from "../../api/queries";
import { Group, Row, Value } from "../../ui/controls";
import { LoadError } from "./load-error";

const LINK: Record<PikvmTarget["link"], { text: string; tone: "ok" | "warn" | "danger" | "idle" }> = {
    connected: { text: "Connected", tone: "ok" },
    connecting: { text: "Connecting", tone: "warn" },
    offline: { text: "Offline", tone: "danger" },
    // The server opens the PiKVM event socket lazily, so "unknown" is "not yet", not "down".
    unknown: { text: "Not checked yet", tone: "idle" },
};

export function ConnectionPage() {
    const state = useAppState();

    if (state.isError) return <LoadError message={state.error.message} onRetry={() => void state.refetch()} />;

    const target = state.data?.pikvm;
    const link = target ? LINK[target.link] : undefined;

    return (
        <Group
            title="PiKVM"
            footer="The PiKVM is set when the host starts. Change it in the host's configuration, not here."
        >
            <Row label="Address">
                <Value>{target?.origin ?? "Loading"}</Value>
            </Row>
            <Row label="Link">
                <Value>
                    {link ? <span className="status-dot" data-tone={link.tone} aria-hidden="true" /> : null}
                    {link?.text ?? "Loading"}
                </Value>
            </Row>
        </Group>
    );
}
