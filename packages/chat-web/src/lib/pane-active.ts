/**
 * Whether the Chat pane is the one in front. The host keeps hidden tabs mounted (and inert), so anything that listens
 * on the window or document must stand down while this is false, or a hidden pane would react to the KVM's keys.
 * Components that attach such listeners read `usePaneActive()` and attach only while it is true.
 */
import { createContext, useContext } from "react";

export const PaneActiveContext = createContext(true);

export const usePaneActive = (): boolean => useContext(PaneActiveContext);
