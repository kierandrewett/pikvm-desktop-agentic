/**
 * The model a subagent ran on (SubagentRun.model, `provider/modelId`), as the model picker names it: the vendor
 * logo and the catalogue's friendly name. A model the catalogue no longer lists shows its id after the provider.
 * Runs without a model (older history, or still starting) show nothing.
 */
import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import { cn } from "../../lib/cn";
import { identityOf, modelsQuery } from "../model-picker/models";
import { ModelMark, ProviderLogo } from "../model-picker/provider-logo";

export const SubagentModel = memo(function SubagentModel({
    model,
    className,
}: {
    model: string | undefined;
    className?: string;
}) {
    const { data } = useQuery({ ...modelsQuery, enabled: !!model });
    if (!model) return null;
    const info = data?.models.find((m) => m.id === model);
    const name = info?.name ?? model.slice(model.indexOf("/") + 1);
    return (
        <span
            data-subagent-model={model}
            title={info ? identityOf(info).label : model}
            className={cn("inline-flex min-w-0 items-center gap-1 text-tertiary", className)}
        >
            {info ? <ModelMark model={info} size={14} /> : <ProviderLogo src={undefined} name={name} size={14} />}
            <span className="truncate">{name}</span>
        </span>
    );
});
