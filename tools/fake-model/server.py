"""A scripted OpenAI-compatible model for end-to-end runs of the agent harness.

It answers POST /v1/chat/completions the way the harness's `openai_compatible`
provider expects (a JSON object in the first choice's message), choosing the
reply from the role named in the request's response_format schema
(`pikvm_assistant`, `pikvm_reasoner`, `pikvm_controller`, `pikvm_verifier`).

Two scripted tasks, picked by what the user's message asks for:

  "click ..."     plan, ONE click at the centre of the screen, verified. The
                  harness lets a plain click through, so nothing waits for a human.
  "approve ..."   plan, ONE bare Enter that the harness's policy holds for a
                  person to approve (it may commit whatever has focus), then
                  executes once approved and verifies.

Anything else gets a plain reply. Every request is logged (without the image)
to stdout so a run can be read back. Never used outside tests: it asks nothing
of a real model and calls no network.
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

CLICK_X, CLICK_Y = 160, 90
# The assistant's hand-off carries one of these, so later roles know which script they are in.
CLICK_TASK = "Click the centre of the screen once. [[fake:click]]"
APPROVE_TASK = "Press Enter once, which needs approval. [[fake:approve]]"


def answer(role: str, prompt: str) -> dict[str, Any]:
    typed = "[[fake:approve]]" in prompt
    if role == "assistant":
        lowered = prompt.lower()
        # The harness frames the conversation in a long prompt; the user's own
        # words are the ones after the last "user" turn marker, but the keyword
        # test is enough because the framing never contains these two phrases.
        if "please approve" in lowered:
            return {"outcome": "computer", "message": "", "computer_task": APPROVE_TASK}
        if "please click" in lowered:
            return {"outcome": "computer", "message": "", "computer_task": CLICK_TASK}
        return {"outcome": "reply", "message": "Hello from the fake model.", "computer_task": None}
    if role == "reasoner":
        return {
            "summary": "Press Enter once." if typed else "Click the centre of the screen once.",
            "steps": ["Press Enter"] if typed else ["Click the centre of the screen"],
            "success_criteria": ["Enter was pressed"] if typed else ["The click was delivered"],
            "constraints": [],
        }
    if role == "controller":
        if typed:
            return {
                "outcome": "act",
                "intent": "Press Enter",
                "actions": [{"type": "key", "keys": ["ENTER"]}],
                "expected_evidence": ["Enter was pressed"],
                "expects_task_completion": True,
            }
        return {
            "outcome": "act",
            "intent": "Click the centre of the screen",
            "actions": [{"type": "click", "x": CLICK_X, "y": CLICK_Y, "button": "left"}],
            "expected_evidence": ["The pointer is at the centre"],
            "expects_task_completion": True,
        }
    if role == "verifier":
        return {"verdict": "complete", "summary": "The action was delivered.", "evidence": ["fake"]}
    raise ValueError(f"unknown role {role!r}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args: Any) -> None:  # the request log below is the one that matters
        return

    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200 if self.path in {"/", "/healthz", "/v1/models"} else 404)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"data": [{"id": "fake-model"}]}')

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.endswith("/chat/completions"):
            self.send_response(404)
            self.end_headers()
            return
        schema_name = payload["response_format"]["json_schema"]["name"]
        role = schema_name.removeprefix("pikvm_")
        content = payload["messages"][0]["content"]
        prompt = content if isinstance(content, str) else "".join(p.get("text", "") for p in content if p.get("type") == "text")
        try:
            data = answer(role, prompt)
            status = 200
        except ValueError as exc:
            data, status = {"error": str(exc)}, 400
        # Proof the harness sent the key it holds, without printing it.
        key = (self.headers.get("authorization") or "").removeprefix("Bearer ")
        print(
            json.dumps({"role": role, "prompt_chars": len(prompt), "key_tail": key[-4:], "reply": data}),
            flush=True,
        )
        if "--dump" in sys.argv:
            print(prompt, flush=True)
        body = json.dumps(
            {
                "model": "fake-model",
                "choices": [{"message": {"content": json.dumps(data)}}],
                "usage": {"total_tokens": 1},
            }
            if status == 200
            else data
        ).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9000)
    parser.add_argument("--dump", action="store_true", help="also print each prompt")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"fake model on http://{args.host}:{args.port}/v1", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
