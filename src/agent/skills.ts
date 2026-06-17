/**
 * Skills: reusable markdown playbooks the agent can list and load on demand.
 * Stored as `.md` files; first line `# Title` and an optional `> description`
 * line form the summary. A couple of examples are seeded on first run.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

export interface SkillSummary {
    name: string;
    title: string;
    description: string;
}

const SEED: Record<string, string> = {
    "web-research": `# Web research
> Research a topic on the web and summarise findings with sources.

1. Use \`web_search\` with a focused query.
2. \`fetch_url\` the 2–3 most relevant results for detail.
3. Cross-check facts across sources; note disagreements.
4. Summarise concisely and list the source URLs you used.
5. \`remember\` any durable facts worth keeping for later.`,
    "enter-bios": `# Enter BIOS / firmware setup
> Reboot the target and enter its BIOS/UEFI setup screen.

1. \`screenshot\` to see the current state.
2. Trigger a reboot (only with authorization).
3. Watch for the POST screen and repeatedly \`press_key\` the setup key
   (commonly Delete, F2, F10, or Esc) during early boot.
4. \`screenshot\` to confirm you reached the firmware menus before proceeding.`,
};

export class SkillStore {
    constructor(private readonly dir: string) {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
            for (const [name, body] of Object.entries(SEED)) {
                try {
                    writeFileSync(resolve(dir, `${name}.md`), body);
                } catch {
                    /* ignore */
                }
            }
        }
    }

    private files(): string[] {
        try {
            return readdirSync(this.dir).filter((f) => f.endsWith(".md"));
        } catch {
            return [];
        }
    }

    list(): SkillSummary[] {
        return this.files().map((f) => {
            const name = f.replace(/\.md$/, "");
            let title = name;
            let description = "";
            try {
                const text = readFileSync(resolve(this.dir, f), "utf-8");
                title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name;
                description = text.match(/^>\s+(.+)$/m)?.[1]?.trim() ?? "";
            } catch {
                /* ignore */
            }
            return { name, title, description };
        });
    }

    get(name: string): string | null {
        const safe = name.replace(/[^a-z0-9_-]/gi, "");
        const path = resolve(this.dir, `${safe}.md`);
        return existsSync(path) ? readFileSync(path, "utf-8") : null;
    }
}
