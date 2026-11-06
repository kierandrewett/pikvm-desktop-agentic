import { Button, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "@pikvm/chat-web/settings";
import { useState } from "react";

/** One snippet with a Copy button. */
function Snippet({ label, text, note }: { label: string; text: string; note?: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <SettingRow
            label={label}
            description={note ? `${text}\n${note}` : text}
            control={
                <Button
                    onClick={() => {
                        void navigator.clipboard.writeText(text).then(() => setCopied(true));
                    }}
                >
                    {copied ? "Copied" : "Copy"}
                </Button>
            }
        />
    );
}

/**
 * How to give an agent on this machine, or anywhere, the PiKVM tools: this host's own MCP server (docs/deploy-web.md, "MCP server").
 * The agent signs in with the browser the first time it connects; nothing is typed here.
 */
export function McpPage() {
    const address = `${window.location.origin}/app/mcp`;
    return (
        <SettingsPage
            title="MCP server"
            description="Give any agent that supports MCP the screen, keyboard and mouse of this PiKVM."
        >
            <SettingsSection title="Address">
                <SettingsCard>
                    <Snippet label="MCP address" text={address} note="Streamable HTTP. The agent signs in through your browser the first time it connects." />
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Set it up in an agent">
                <SettingsCard>
                    <Snippet label="Claude Code" text={`claude mcp add --transport http pikvm ${address}`} note="Then run /mcp in Claude Code and choose Authenticate." />
                    <Snippet label="Codex" text={`[mcp_servers.pikvm]\nurl = "${address}"`} note="Add it to ~/.codex/config.toml, then run: codex mcp login pikvm" />
                    <Snippet label="Cursor and other clients" text={JSON.stringify({ mcpServers: { pikvm: { url: address } } }, null, 2)} note="Put it in the client's MCP settings file (Cursor: ~/.cursor/mcp.json)." />
                    <Snippet label="A script" text={`Authorization: Bearer <access token>`} note="For a client that cannot open a browser. The access token is the one this host was started with." />
                </SettingsCard>
            </SettingsSection>
            <SettingsSection title="What the agent can do">
                <SettingsCard>
                    <SettingRow
                        label="Same tools as the chat"
                        description="Screenshot, read text, move, click, drag, scroll, type and press keys. Actions that need approval are refused, because nobody can be asked outside a chat. Each agent shows in Settings, Account, where you can revoke it."
                    />
                </SettingsCard>
            </SettingsSection>
        </SettingsPage>
    );
}
