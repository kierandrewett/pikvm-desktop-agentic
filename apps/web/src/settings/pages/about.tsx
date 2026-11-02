import { useAppState } from "../../api/queries";
import { Group, Row, Value } from "../../ui/controls";

export function AboutPage() {
    const state = useAppState();
    return (
        <Group title="PiKVM">
            <Row label="App version">
                <Value>{__APP_VERSION__}</Value>
            </Row>
            <Row label="Host version">
                <Value>{state.data?.version ?? (state.isError ? "Unavailable" : "Loading")}</Value>
            </Row>
        </Group>
    );
}
