import { CircleNotch } from "@pikvm/icons";
import { cn } from "./lib/cn";

export function Spinner({ className }: { className?: string }) {
    return <CircleNotch className={cn("size-4 shrink-0 animate-spin text-tertiary", className)} aria-hidden />;
}
