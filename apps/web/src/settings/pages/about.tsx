import { useEffect, useState } from "react";
import { useAppState } from "../../api/queries";
import { viewportReport } from "../../app/viewport-report";
import { desktopBridge } from "../../host/desktop";
import { Group, Row, Value } from "../../ui/controls";

const PLATFORM = { linux: "Linux", darwin: "macOS", win32: "Windows" } as const;

export function AboutPage() {
    const state = useAppState();
    // Measured when the page opens: what this device reports about its viewport (see viewport-report.ts).
    const [viewport, setViewport] = useState("");
    useEffect(() => setViewport(viewportReport()), []);
    const desktop = desktopBridge();
    return (
        <Group title="PiKVM">
            {desktop ? (
                <Row label="Desktop app">
                    <Value>
                        {desktop.version} on {PLATFORM[desktop.platform]}
                    </Value>
                </Row>
            ) : null}
            <Row label="App version">
                <Value>{__APP_VERSION__}</Value>
            </Row>
            <Row label="App build">
                <Value>{__BUILD_ID__}</Value>
            </Row>
            <Row label="Host version">
                <Value>{state.data?.version ?? (state.isError ? "Unavailable" : "Loading")}</Value>
            </Row>
            {viewport === "" ? null : (
                <Row label="Viewport">
                    <Value>{viewport}</Value>
                </Row>
            )}
        </Group>
    );
}
