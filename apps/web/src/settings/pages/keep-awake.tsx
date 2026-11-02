import { Group, InlineError, Row, Switch } from "../../ui/controls";
import { useServerSettings } from "../use-settings";
import { LoadError } from "./load-error";

export function KeepAwakePage() {
    const { settings, loading, loadError, retry, saving, saveError, save } = useServerSettings();

    if (loadError) return <LoadError message={loadError} onRetry={retry} />;

    return (
        <Group
            title="Mouse jiggler"
            footer="While the target is idle, nudge its mouse now and then so it does not lock or sleep."
        >
            <Row label="Keep the target awake">
                <Switch
                    label="Keep the target awake"
                    checked={settings?.jiggler}
                    disabled={loading || saving}
                    onChange={(jiggler) => save({ jiggler })}
                />
            </Row>
            {saveError ? <InlineError>Could not save: {saveError}</InlineError> : null}
        </Group>
    );
}
