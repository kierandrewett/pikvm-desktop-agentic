/**
 * Registry of icons drawn for this package rather than taken from Phosphor.
 *
 * Each entry gives Phosphor-style source outlines (expanded strokes, sharp inside corners) for the three shipped
 * weights. The build smooths and checks them exactly like Phosphor icons, writes src/generated/<name>.ts and
 * exports <name> and <name>Icon. A name must not clash with a Phosphor icon; the build stops if it does.
 * Overrides in scripts/overrides.ts use the kebab-case name ("chat-compose").
 */
import { chatCompose, VARIANTS as CHAT_COMPOSE_VARIANTS } from "./chat-compose.ts";

export interface CustomIcon {
    /** PascalCase export name, or a free label for preview-only variants. */
    name: string;
    paths: Readonly<Record<"regular" | "fill" | "bold", readonly string[]>>;
}

export const CUSTOM_ICONS: readonly CustomIcon[] = [chatCompose];

/** Design candidates shown in the preview next to the chosen icon. Not exported from the package. */
export const CUSTOM_VARIANTS: Readonly<Record<string, readonly CustomIcon[]>> = {
    ChatCompose: CHAT_COMPOSE_VARIANTS,
};
