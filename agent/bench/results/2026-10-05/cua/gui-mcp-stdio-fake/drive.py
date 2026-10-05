"""Drive `pikvm-agent gui-mcp` over real stdio as a harness would.

Fake screen (PIKVM_AGENT_FAKE=1), real model via OpenRouter. A stand-in
"desktop" process and ticket play PiKVM Desktop's part of the gate.
"""
import asyncio, hashlib, json, os, secrets, subprocess, sys, tempfile
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main() -> None:
    desktop = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    token = secrets.token_hex(32)
    ticket = Path(tempfile.mkdtemp()) / "gui-mcp.json"
    ticket.write_text(json.dumps({"schema_version": 1, "desktop_pid": desktop.pid,
                                  "token_sha256": hashlib.sha256(token.encode()).hexdigest()}))
    ticket.chmod(0o600)
    env = {**os.environ, "PIKVM_GUI_MCP_TOKEN": token, "PIKVM_GUI_MCP_TICKET": str(ticket),
           "PIKVM_AGENT_FAKE": "1", "CUA_TELEMETRY_ENABLED": "false"}
    params = StdioServerParameters(command=sys.executable, args=["-m", "pikvm_agent.cli", "gui-mcp"], env=env)
    try:
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
    finally:
        desktop.kill()

asyncio.run(main())
