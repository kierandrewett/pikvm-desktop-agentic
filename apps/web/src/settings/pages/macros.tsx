import type { Macro } from "@pikvm/contracts/api";
import { useMacros } from "../../api/queries";
import { Group, Row, Value } from "../../ui/controls";
import { PinIcon } from "../../ui/icons";
import { LoadError } from "./load-error";

const stepSummary = (macro: Macro): string => {
    const n = macro.steps.length;
    return `${n} ${n === 1 ? "step" : "steps"}`;
};

/** Read-only for now: run and edit stay in the console until the KVM screen is ported. */
export function MacrosPage() {
    const macros = useMacros();

    if (macros.isError) return <LoadError message={macros.error.message} onRetry={() => void macros.refetch()} />;

    if (macros.isPending) {
        return (
            <Group title="Macros">
                <Row label="Loading" />
            </Group>
        );
    }

    if (macros.data.length === 0) {
        return (
            <Group title="Macros" footer="Macros are made in the KVM screen's menu.">
                <Row label="No macros yet" />
            </Group>
        );
    }

    return (
        <Group title="Macros" footer="Macros are run and edited from the KVM screen. Pinned ones sit in its toolbar.">
            {macros.data.map((macro) => (
                <Row key={macro.id} label={macro.label} hint={stepSummary(macro)}>
                    {macro.pinned ? (
                        <Value>
                            <span className="inline-flex items-center gap-1" title="Pinned to the toolbar">
                                <PinIcon width={14} height={14} />
                                Pinned
                            </span>
                        </Value>
                    ) : null}
                </Row>
            ))}
        </Group>
    );
}
