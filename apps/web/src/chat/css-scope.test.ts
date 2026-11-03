import { describe, expect, it } from "vitest";
import { scopeTheme } from "../../scope-chat-theme";

const pane = "@layer theme {\n  :root,\n  :host {\n    --font-sans: var(--font-ui);\n    --radius-sm: var(--radius-sm);\n  }\n}\n.chat-scope { color: red; }";
const app = "@layer theme {\n  :root,\n  :host {\n    --font-sans: \"Geist Variable\", system-ui;\n  }\n}\n.chat-surface .chat-scope { color: red; }";

describe("the pane's theme block", () => {
    it("moves onto .chat-scope, so it cannot redefine the app's fonts and radii", () => {
        const scoped = scopeTheme(pane);
        expect(scoped).toContain("@layer theme {\n  .chat-scope {");
        expect(scoped).not.toMatch(/:root/);
    });

    it("also in a minified build, and in the dev server's JS string", () => {
        expect(scopeTheme("@layer theme{:root,:host{--font-sans:var(--font-ui)}}")).toBe("@layer theme{.chat-scope{--font-sans:var(--font-ui)}}");
        const dev = JSON.stringify(pane);
        expect(scopeTheme(dev)).toContain("@layer theme {\\n  .chat-scope {");
    });

    it("leaves the app's own sheet alone, though it mentions .chat-scope", () => {
        expect(scopeTheme(app)).toBe(app);
    });
});
