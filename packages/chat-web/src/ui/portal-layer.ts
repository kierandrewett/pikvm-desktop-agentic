import { createContext, useContext } from "react";

/**
 * The container for portals opened by a primitive (tooltip, and later popover, menu, sheet and dialog).
 *
 * This is the one context the app provides. The app sets it to its theme-scope layer while a scope has a
 * colour, so an overlay opened from inside a scope takes the scope's colours. With no provider the value is
 * undefined and Radix portals render into <body>, which is what global UI wants.
 */
export const PortalLayerContext = createContext<HTMLElement | undefined>(undefined);

/** The portal container for the current position in the tree, or undefined for <body>. */
export function usePortalLayer(): HTMLElement | undefined {
    return useContext(PortalLayerContext);
}
