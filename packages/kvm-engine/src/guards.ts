/**
 * The engine's one structural guard. Frames from kvmd are parsed leniently on purpose (see
 * target/wire.ts), so the readers narrow with this and then `typeof` the fields they use.
 */
export type Rec = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Rec {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
