import { useState } from "react";
import { Group, Row, Segmented } from "../../ui/controls";
import { readThemeChoice, setThemeChoice, type ThemeChoice } from "../../theme";

const CHOICES = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
] as const satisfies ReadonlyArray<{ value: ThemeChoice; label: string }>;

export function DisplayPage() {
    const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);

    return (
        <Group title="Appearance" footer="System follows your device and changes with it.">
            <Row label="Theme">
                <Segmented
                    label="Theme"
                    options={CHOICES}
                    value={choice}
                    onChange={(next) => {
                        setChoice(next);
                        setThemeChoice(next);
                    }}
                />
            </Row>
        </Group>
    );
}
