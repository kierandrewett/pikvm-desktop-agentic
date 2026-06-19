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
    "detect-inactivity": `# Detect inactivity (ignoring a mouse jiggler)
> Decide whether the machine is idle without being fooled by a mouse jiggler.

A "mouse jiggler" nudges the cursor a few pixels periodically to keep the PC awake — that is NOT real activity.
1. \`screenshot\` now and note the meaningful state (focused app/window, visible text/content). You can \`remember\` a short note or compare against a recent frame with \`view_screenshot\`.
2. After the idle window, \`screenshot\` again. Count as ACTIVE only if something MEANINGFUL changed — app/window focus, text, content, real UI updates — NOT merely the mouse cursor shifting a little in place.
3. Also check \`recent_activity\`: if the user typed or clicked through the KVM recently, they are active.
4. If nothing meaningful changed for the whole idle period, treat it as inactive.

To LOCK the computer: Windows → Win+L (\`hotkey\` MetaLeft+KeyL); macOS → Ctrl+Cmd+Q (ControlLeft+MetaLeft+KeyQ); most Linux → Super+L (MetaLeft+KeyL) or Ctrl+Alt+L.
Tip: schedule this check with \`schedule_task\` (e.g. everyMinutes 5, afterTime "17:30").`,
    "neo-corporate-help": `# Neo — internal corporate process help
> Use Neo (neo.capgemini.com) to answer questions about internal corporate processes.

Neo is Capgemini's internal assistant for company processes, policies, tools and how-tos.
For ANY question about internal corporate process/policy:
1. In the target machine's browser, open https://neo.capgemini.com.
2. Ask the question in Neo's chat/search box.
3. Wait for the answer, then \`ocr\`/zoom to read it precisely.
4. Report exactly what Neo says (don't paraphrase loosely or invent details).`,
    "understand-ui": `# Understand the UI before acting
> Figure out how an unfamiliar interface works before interacting — never assume.

1. Never assume what an icon or button does from its appearance alone.
2. Reveal tooltips: hover the control with \`move_mouse\` and wait; if nothing appears, hold Alt (\`press_key\` AltLeft) which surfaces tooltips/labels in many apps.
3. Expand collapsed sidebars, overflow (…) menus and panels, and \`ocr\`/zoom to read the labels.
4. If the app is unfamiliar, \`web_search\` how it works (e.g. "<app> how to <task>") and \`fetch_url\` the docs.
5. Prefer reversible exploration (hover, open menus, read) over clicking unknown controls — clicks have side effects.
6. If you are still genuinely unsure how something works after due diligence, ASK THE USER rather than guessing.`,
    "enter-bios": `# Enter BIOS / firmware setup
> Reboot the target and enter its BIOS/UEFI setup screen.

1. \`screenshot\` to see the current state.
2. Trigger a reboot (only with authorization).
3. Watch for the POST screen and repeatedly \`press_key\` the setup key
   (commonly Delete, F2, F10, or Esc) during early boot.
4. \`screenshot\` to confirm you reached the firmware menus before proceeding.`,
    "fix-keyboard-layout": `# Fix a keyboard layout mismatch on the target
> When typed symbols come out wrong (e.g. ~ becomes ¬, " becomes @), the target's layout does not match what you are sending.

Symptom: symbols like ~ / \\\\ " @ # come out as different characters while letters and numbers are fine. That is a LAYOUT mismatch, not a typo.
Fixes, easiest first:
1. Change the target's input layout to match. On Windows press Win+Space (\`hotkey\` MetaLeft+Space) to cycle input languages/layouts; pick the one that types symbols correctly. Test in a text field and \`ocr\` to confirm.
2. If the right layout is not installed, configure the system yourself — you are not limited to what is already on screen. Windows: Settings → Time & language → Language & region / Typing, add or set the keyboard (e.g. English US vs UK). macOS: System Settings → Keyboard → Input Sources. Linux: Settings → Keyboard.
3. After changing it, retype and \`ocr\` to verify the symbols are right before continuing.
4. \`remember\` which layout this target uses so you do not have to rediscover it.

Note: you also have a US/UK setting (Settings → Behaviour) that changes which physical keys you send. Matching that to the target avoids the problem up front; changing the target's own layout is the fix when you cannot.`,
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
