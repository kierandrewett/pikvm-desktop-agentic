"""Drive `pikvm-agent gui-mcp` over real stdio as a harness would.

Fake screen (PIKVM_AGENT_FAKE=1), real model via OpenRouter. This driver
process plays PiKVM Desktop: the ticket names its pid, and it is the
server's parent, so the ancestry gate passes as it would in the sidebar.
"""
import asyncio, json, os, sys, tempfile
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main() -> None:
    ticket = Path(tempfile.mkdtemp()) / "gui-mcp.json"
    ticket.write_text(json.dumps({"schema_version": 2, "desktop_pid": os.getpid()}))
    ticket.chmod(0o600)
    env = {**os.environ, "PIKVM_AGENT_FAKE": "1", "CUA_TELEMETRY_ENABLED": "false"}
    params = StdioServerParameters(command=sys.executable, args=["-m", "pikvm_agent.cli", "gui-mcp", "--ticket", str(ticket)], env=env)
    if True:
        async with stdio_client(params) as (r, w), ClientSession(r, w) as s:
            await s.initialize()
            res = await s.call_tool("run_computer_task", {
                "task": "Click on the word 'desktop' in the middle-left of the screen, then stop.",
                "wait_seconds": 180, "max_steps": 3})
            for part in res.content:
                if part.type == "text":
                    print(part.text)
                else:
                    print(f"[{part.type} {part.mimeType} {len(part.data)} b64 chars]")
                    Path(sys.argv[1]).write_bytes(__import__("base64").b64decode(part.data))
            print("isError:", res.isError)

asyncio.run(main())
