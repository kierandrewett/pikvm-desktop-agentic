/** Settings > About > Recent drops: the last outages of this tab, newest first. In memory and sessionStorage only. */

import { SettingRow, SettingsCard, SettingsSection } from "@pikvm/chat-web/settings";
import { Value } from "../../settings/pages/value";
import { causeText, formatLength, formatRoundTrip } from "./format";
import { useConnectionSnapshot } from "./use-connection";

const timeOf = (at: number): string =>
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function DropsList() {
    const { outages } = useConnectionSnapshot();
    return (
        <SettingsSection
            title="Recent drops"
            description="Times the connection failed since this tab opened. It is kept in this tab only."
        >
            <SettingsCard>
                {outages.length === 0 ? (
                    <SettingRow label="No drops" control={<Value>None seen</Value>} />
                ) : (
                    outages.map((outage) => (
                        <SettingRow
                            key={outage.startedAt}
                            label={timeOf(outage.startedAt)}
                            description={`${causeText(outage.cause)}. Slowest answer ${formatRoundTrip(outage.longestRoundTripMs)}.`}
                            control={
                                <Value>
                                    {outage.endedAt === null ? "Still going" : formatLength(outage.endedAt - outage.startedAt)}
                                </Value>
                            }
                        />
                    ))
                )}
            </SettingsCard>
        </SettingsSection>
    );
}
