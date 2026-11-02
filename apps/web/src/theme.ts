/**
 * Theme: one stored choice, shared with the console and the agent workspace.
 *
 * The storage key is the console's, so a choice made here is the choice every embedded
 * surface boots with. A saved value is the user's CHOICE and the OS is only the default:
 * following the OS must record nothing, or the next OS change has a "choice" to fight.
 * "system" is therefore the absence of the key.
 */

export const THEME_KEY = "pikvm-console-theme";

export type Theme = "light" | "dark";
export type ThemeChoice = Theme | "system";

const THEME_COLOR: Record<Theme, string> = { light: "#eef0f4", dark: "#0a0a0c" };

type Listener = (theme: Theme) => void;
const listeners = new Set<Listener>();

export function readThemeChoice(): ThemeChoice {
    try {
        const raw = localStorage.getItem(THEME_KEY);
        return raw === "light" || raw === "dark" ? raw : "system";
    } catch {
        return "system";
    }
}

export function osTheme(): Theme {
    try {
        return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
        return "dark";
    }
}

export function resolveTheme(choice: ThemeChoice): Theme {
    return choice === "system" ? osTheme() : choice;
}

/** The theme currently showing. */
export function currentTheme(): Theme {
    return resolveTheme(readThemeChoice());
}

function paint(theme: Theme): void {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    // The embedded workspace's component library keys its palette off a `dark` class, so
    // both are kept in step exactly as the console does.
    root.classList.toggle("dark", theme === "dark");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
    for (const listener of listeners) listener(theme);
}

/** Persist a choice (or clear it for "system") and repaint. */
export function setThemeChoice(choice: ThemeChoice): void {
    try {
        if (choice === "system") localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, choice);
    } catch {
        // Storage can be unavailable (private mode); the choice then lasts until reload.
    }
    paint(resolveTheme(choice));
}

/** Be told whenever the painted theme changes. Returns the unsubscribe. */
export function subscribeTheme(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Paint the stored (or OS) theme and follow live OS changes while no choice is stored. */
export function initTheme(): () => void {
    paint(currentTheme());
    let query: MediaQueryList | undefined;
    try {
        query = window.matchMedia("(prefers-color-scheme: light)");
    } catch {
        return () => {};
    }
    const onChange = () => {
        if (readThemeChoice() === "system") paint(osTheme());
    };
    query.addEventListener("change", onChange);
    return () => query?.removeEventListener("change", onChange);
}
