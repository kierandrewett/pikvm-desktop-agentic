import { InlineError } from "../../ui/controls";

/** A page whose data failed to load: the reason, and a way to try again. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="flex flex-col items-start gap-3">
            <InlineError>Could not load: {message}</InlineError>
            <button type="button" className="btn" onClick={onRetry}>
                Try again
            </button>
        </div>
    );
}
