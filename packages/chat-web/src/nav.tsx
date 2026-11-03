/**
 * Navigation inside the Chat pane.
 *
 * The pane is a tab of the host app, so it must not touch the browser's URL. Its "location" (a conversation, the new
 * chat screen, a settings deep link) lives in a small store provided by ChatScope, and the lifted pages keep their
 * `Link`, `useNavigate` and `useSearch` calls against it.
 *
 * Paths: `/` is the new-chat screen, `/c/$conversationId` a conversation. Anything else is a settings deep link whose
 * search params the integration pages read (`?add=<preset>`).
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

export type SearchParams = Record<string, unknown>;

export interface ParsedLocation {
    pathname: string;
    search: SearchParams;
    hash: string;
    href: string;
}

/** Where to go. `to` is a path pattern whose `$name` segments `params` fill. */
export interface Dest {
    to?: string;
    params?: Record<string, string | undefined>;
    /** `true` keeps the current search. */
    search?: SearchParams | true | ((prev: SearchParams) => SearchParams);
    hash?: string | true;
    replace?: boolean;
    resetScroll?: boolean;
}

export interface NavStore {
    location(): ParsedLocation;
    navigate(dest: Dest): void;
    subscribe(listener: () => void): () => void;
}

function fill(pattern: string, params: Dest["params"]): string {
    return pattern.replace(/\$(\w+)/g, (_m, name: string) => encodeURIComponent(params?.[name] ?? ""));
}

function parse(pathname: string, search: SearchParams, hash: string): ParsedLocation {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(search)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const query = qs.toString();
    return { pathname, search, hash, href: `${pathname}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}` };
}

export function createNavStore(initial = "/"): NavStore {
    let current = parse(initial, {}, "");
    const listeners = new Set<() => void>();
    return {
        location: () => current,
        navigate(dest) {
            const pathname = dest.to === undefined || dest.to === "." ? current.pathname : fill(dest.to, dest.params);
            const search =
                dest.search === true
                    ? current.search
                    : typeof dest.search === "function"
                      ? dest.search(current.search)
                      : (dest.search ?? {});
            const hash = dest.hash === true ? current.hash : (dest.hash ?? "");
            current = parse(pathname, search, hash);
            for (const l of listeners) l();
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

const NavContext = createContext<NavStore | null>(null);

export function NavProvider({ store, children }: { store: NavStore; children: ReactNode }) {
    return <NavContext.Provider value={store}>{children}</NavContext.Provider>;
}

function useStore(): NavStore {
    const store = useContext(NavContext);
    if (!store) throw new Error("Chat navigation used outside ChatScope");
    return store;
}

export function useLocation<T = ParsedLocation>(opts?: { select?: (location: ParsedLocation) => T }): T {
    const store = useStore();
    const loc = useSyncExternalStore(store.subscribe, store.location, store.location);
    return opts?.select ? opts.select(loc) : (loc as T);
}

export const useRouterState = <T,>(opts: { select: (state: { location: ParsedLocation }) => T }): T =>
    useLocation({ select: (location) => opts.select({ location }) });

export function useNavigate(): (dest: Dest) => Promise<void> {
    const store = useStore();
    return useCallback(
        async (dest: Dest) => {
            store.navigate(dest);
        },
        [store],
    );
}

export function useSearch<T = SearchParams>(opts?: { select?: (search: SearchParams) => T }): T {
    return useLocation({ select: (l) => (opts?.select ? opts.select(l.search) : (l.search as T)) });
}

/** Params of the open path: `conversationId` on `/c/<id>`. */
export function useParams<T = Record<string, string>>(opts?: { select?: (params: Record<string, string>) => T }): T {
    return useLocation({
        select: (l) => {
            const m = /^\/c\/([^/]+)/.exec(l.pathname);
            const params: Record<string, string> = m?.[1] ? { conversationId: decodeURIComponent(m[1]) } : {};
            return opts?.select ? opts.select(params) : (params as T);
        },
    });
}

export interface ChatRouter {
    navigate(dest: Dest): Promise<void>;
    state: { location: ParsedLocation };
}

/** The slice of a router that actions need. Not reactive: read `state.location` when acting. */
export function useRouter(): ChatRouter {
    const store = useStore();
    return useMemo(
        () => ({
            navigate: async (dest: Dest) => store.navigate(dest),
            get state() {
                return { location: store.location() };
            },
        }),
        [store],
    );
}

export interface LinkProps extends Dest {
    children?: ReactNode;
    className?: string;
    title?: string;
    "aria-label"?: string;
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

export function Link({ to, params, search, hash, replace, onClick, children, ...rest }: LinkProps) {
    const store = useStore();
    const dest: Dest = { to, params, search, hash, replace };
    const href = useMemo(() => {
        const base = store.location();
        const pathname = to === undefined ? base.pathname : fill(to, params);
        return `#chat:${pathname}`;
    }, [store, to, params]);
    return (
        <a
            {...rest}
            href={href}
            onClick={(e) => {
                onClick?.(e);
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                store.navigate(dest);
            }}
        >
            {children}
        </a>
    );
}
