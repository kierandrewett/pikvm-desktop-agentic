import type { Settings, SettingsPatch } from "@pikvm/contracts/api";
import { useAppState, useUpdateSettings } from "../api/queries";

/**
 * The server settings with the save in flight folded in: while a change is pending the page
 * shows the value being saved, and when the save fails it snaps back to the server's
 * value with the reason beside it. No cache surgery, so there is nothing to roll back.
 */
export function useServerSettings() {
    const state = useAppState();
    const mutation = useUpdateSettings();
    const pending: SettingsPatch | undefined = mutation.isPending ? mutation.variables : undefined;

    const saved: Settings | undefined = state.data?.settings;
    const shown: Settings | undefined = saved
        ? {
              keyboardLayout: pending?.keyboardLayout ?? saved.keyboardLayout,
              jiggler: pending?.jiggler ?? saved.jiggler,
          }
        : undefined;

    return {
        /** What to draw. Undefined until the first load. */
        settings: shown,
        loading: state.isPending,
        loadError: state.isError ? state.error.message : undefined,
        retry: () => void state.refetch(),
        saving: mutation.isPending,
        saveError: mutation.isError ? mutation.error.message : undefined,
        save: (patch: SettingsPatch) => mutation.mutate(patch),
    };
}
