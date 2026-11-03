/**
 * Feature contract for the shared composer. These switches control UI and local actions, not server permissions.
 * Omitted keys preserve the complete Chat interface. Embedded hosts can start from BASIC_COMPOSER_FEATURES.
 */
import { z } from "zod";

export const ComposerFeatures = z
    .object({
        modelPicker: z.boolean().default(true),
        effort: z.boolean().default(true),
        permissions: z.boolean().default(true),
        mcp: z.boolean().default(true),
        attachments: z.boolean().default(true),
        mentions: z.boolean().default(true),
        commands: z.boolean().default(true),
        dictation: z.boolean().default(true),
        fullscreen: z.boolean().default(true),
        disclaimer: z.boolean().default(true),
    })
    .strict();

export type ComposerFeatures = z.infer<typeof ComposerFeatures>;
export type ComposerFeatureOptions = z.input<typeof ComposerFeatures>;

export const FULL_COMPOSER_FEATURES: Readonly<ComposerFeatures> = Object.freeze(ComposerFeatures.parse({}));
export const BASIC_COMPOSER_FEATURES: Readonly<ComposerFeatures> = Object.freeze(
    ComposerFeatures.parse({
        modelPicker: false,
        effort: false,
        permissions: false,
        mcp: false,
        attachments: false,
        mentions: false,
        commands: false,
        dictation: false,
        fullscreen: false,
        disclaimer: false,
    }),
);
