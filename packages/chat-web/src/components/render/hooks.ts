/**
 * Small hooks shared by the renderers: an async load with an explicit state machine, element size,
 * and a per-viewer preference read from localStorage (a convenience only; it may be unavailable).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Resource } from "./resource";
import { translate } from "../../l10n/runtime";
import { toast } from "../ui/toast";

/** idle -> loading -> ready | error. `retry` re-runs the loader. */
export type Load<T> =
    | { status: "loading"; retry: () => void }
    | { status: "ready"; data: T; retry: () => void }
    | { status: "error"; error: unknown; retry: () => void };

export function useLoad<T>(resource: Resource, load: () => Promise<T>, deps: readonly unknown[]): Load<T> {
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<{
        resource: Resource;
        attempt: number;
        generation: unknown;
        result: { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: unknown };
    } | null>(null);
    const generation = useMemo(() => ({}), [resource, ...deps, attempt]);
    const latestGeneration = useRef(generation);
    latestGeneration.current = generation;
    const retry = useCallback(() => {
        if (resource.isCurrent() && latestGeneration.current === generation) setAttempt((value) => value + 1);
    }, [resource, generation]);
    useEffect(() => {
        if (!resource.isCurrent()) return;
        let alive = true;
        setState({ resource, attempt, generation, result: { status: "loading" } });
        void Promise.resolve()
            .then(() => {
                if (!alive || !resource.isCurrent() || latestGeneration.current !== generation) {
                    throw new DOMException("The file owner is no longer current.", "AbortError");
                }
                return load();
            })
            .then(
                (data) => {
                    if (alive && resource.isCurrent() && latestGeneration.current === generation) {
                        setState({ resource, attempt, generation, result: { status: "ready", data } });
                    }
                },
                (error: unknown) => {
                    if (
                        !alive ||
                        !resource.isCurrent() ||
                        latestGeneration.current !== generation ||
                        (error instanceof DOMException && error.name === "AbortError")
                    )
                        return;
                    setState({ resource, attempt, generation, result: { status: "error", error } });
                },
            );
        return () => {
            alive = false;
        };
        // The caller lists loader inputs; load itself is a new closure on each render.
    }, [resource, generation]);
    if (
        !resource.isCurrent() ||
        state?.resource !== resource ||
        state.attempt !== attempt ||
        state.generation !== generation
    ) {
        return { status: "loading", retry };
    }
    return { ...state.result, retry } as Load<T>;
}

export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
    const [size, setSize] = useState({ width: 0, height: 0 });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const update = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            setSize((s) => (s.width === w && s.height === h ? s : { width: w, height: h }));
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return size;
}

/** A remembered boolean (for example "wrap long lines"), shared by every renderer instance. */
export function usePreference(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
    const [value, setValue] = useState(() => {
        try {
            const v = localStorage.getItem(key);
            return v === null ? fallback : v === "1";
        } catch {
            return fallback;
        }
    });
    const set = useCallback(
        (v: boolean) => {
            setValue(v);
            try {
                localStorage.setItem(key, v ? "1" : "0");
            } catch {
                // Private mode or blocked storage: the choice lasts for this view only.
            }
        },
        [key],
    );
    return [value, set];
}

/** Copy text and show a check for 1.5s. */
export function useCopied(): [boolean, (text: string) => void] {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);
    const copy = useCallback((text: string) => {
        if (!navigator.clipboard) {
            toast.error(translate("render-copy-unavailable"));
            return;
        }
        void navigator.clipboard.writeText(text).then(
            () => {
                setCopied(true);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), 1500);
            },
            () => toast.error(translate("render-copy-failed"), { description: translate("render-copy-failed-hint") }),
        );
    }, []);
    return [copied, copy];
}

/** Latest value in a ref, for event handlers registered once. */
export function useLatest<T>(value: T): RefObject<T> {
    const ref = useRef(value);
    ref.current = value;
    return ref;
}
