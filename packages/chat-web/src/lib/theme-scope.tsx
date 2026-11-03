/**
 * The portal layer. Chat's tokens live under `.chat-scope`, and a menu or dialog portalled into <body> would lose
 * them, so ChatScope provides a layer element inside the scope and every overlay renders there. A hidden Chat pane
 * (inert) takes its open overlays with it. Agent colour scopes are not part of this app: the scope hooks are inert.
 */
import { createContext, useContext, type ReactNode, type RefObject } from "react";
import { PortalLayerContext } from "../ui/index";

export { PortalLayerContext };

/** The element overlays render into: the Chat scope's layer. */
export function useThemeLayer(): HTMLElement | undefined {
    return useContext(PortalLayerContext);
}

/** No-op kept for primitives that take a scope on their own element (side panels). */
export function useThemeScopeTarget(_ref: RefObject<HTMLElement | null>): void {}

export function ThemeScope({ children }: { colour?: undefined; children: ReactNode }) {
    return <>{children}</>;
}

export function ThemeScopeExit({ children }: { children: ReactNode }) {
    return <>{children}</>;
}

export const ThemeLayerContext = createContext<HTMLElement | undefined>(undefined);
