import type { KeyboardLayout } from "@pikvm/contracts/api";
import { Group, InlineError, Row, Segmented } from "../../ui/controls";
import { useServerSettings } from "../use-settings";
import { LoadError } from "./load-error";

const LAYOUTS = [
    { value: "us", label: "US" },
    { value: "uk", label: "UK" },
] as const satisfies ReadonlyArray<{ value: KeyboardLayout; label: string }>;

export function KeyboardPage() {
    const { settings, loading, loadError, retry, saving, saveError, save } = useServerSettings();

    if (loadError) return <LoadError message={loadError} onRetry={retry} />;

    return (
        <Group
            title="Layout"
            footer="The layout of the keyboard on the target, used when text is typed for you. It does not change what your own keyboard sends."
        >
            <Row label="Keyboard layout">
                <Segmented
                    label="Keyboard layout"
                    options={LAYOUTS}
                    value={settings?.keyboardLayout}
                    disabled={loading || saving}
                    onChange={(keyboardLayout) => save({ keyboardLayout })}
                />
            </Row>
            {saveError ? <InlineError>Could not save the layout: {saveError}</InlineError> : null}
        </Group>
    );
}
