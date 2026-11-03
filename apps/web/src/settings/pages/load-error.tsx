import { Button, Notice } from "@pikvm/chat-web/settings";

/** A page whose data failed to load: the reason, and a way to try again. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <Notice tone="danger" action={<Button onClick={onRetry}>Try again</Button>}>
            Could not load: {message}
        </Notice>
    );
}
