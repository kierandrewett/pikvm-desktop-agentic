import { Clock as EffectClock, Duration, Effect } from "effect";
import type { Clock } from "./clock";

/**
 * Lets Effect's own `sleep`, `Schedule` and `Clock` run on the engine's Clock port.
 *
 * Without this the target link's backoff and heartbeat would run on Effect's real-time
 * clock while the rest of the engine ran on the injected one, and no test could advance
 * both. Provide it with `Effect.withClock(toEffectClock(clock))`.
 */
export function toEffectClock(clock: Clock): EffectClock.Clock {
    const nanos = (): bigint => BigInt(Math.round(clock.now() * 1000)) * 1000n;
    return {
        [EffectClock.ClockTypeId]: EffectClock.ClockTypeId,
        currentTimeMillis: Effect.sync(() => clock.now()),
        currentTimeNanos: Effect.sync(nanos),
        unsafeCurrentTimeMillis: () => clock.now(),
        unsafeCurrentTimeNanos: nanos,
        sleep: (duration) =>
            Effect.async<void>((resume) => {
                const cancel = clock.setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
                return Effect.sync(cancel);
            }),
    };
}
