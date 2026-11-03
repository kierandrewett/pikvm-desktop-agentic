/**
 * Limits on how long one turn may keep retrying after a model error. One source for two places:
 * the generated runtime config (`retryConfig`, written into config.yml by config.ts) and the server's own
 * backstop in sessions.ts (`MAX_TURN_RETRIES`). Both read these values, so they cannot drift apart.
 */

/**
 * Whole-turn retries the runtime may make after a model error. Each runtime attempt already retries the
 * request itself (408/429/5xx, about 12 requests over 30 s); the runtime's own whole-turn limit is 10 with
 * backoff up to 5 minutes, which reads as an endless "Thinking". 0: the first whole-turn retry ends the
 * response as failed with the provider's message.
 */
export const MAX_TURN_RETRIES = 0;

/** Longest wait between retries, in ms. A provider that asks for a longer wait fails the turn at once. */
export const RETRY_MAX_DELAY_MS = 30_000;

/** The `retry` section of config.yml. The generator is the only writer; never edit the generated file. */
export function retryConfig(): Record<string, unknown> {
    return {
        maxRetries: MAX_TURN_RETRIES,
        maxDelayMs: RETRY_MAX_DELAY_MS,
        // Sleeping until a quota window resets holds the turn for hours. Fail with the provider's message instead.
        waitForUsageReset: false,
    };
}
