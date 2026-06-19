// Smoke test for the reverse proxy + agent-asset serving against a mock PiKVM.
// Bundle to dist/ (so web-assets resolves dist/views) and run with node.
//   esbuild scripts/smoke-proxy.ts --bundle --platform=node --format=cjs --outfile=dist/smoke-proxy.cjs && node dist/smoke-proxy.cjs

import { createServer, type AddressInfo } from "node:http";
import { PiKvmControl } from "../src/pikvm-control";
import { createPiKvmProxy } from "../src/proxy";
import { webAssets } from "../src/web-assets";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
}

async function main(): Promise<void> {
    // 1. Mock PiKVM target.
    const pi = createServer((req, res) => {
        if (req.url === "/") {
            res.writeHead(200, {
                "content-type": "text/html",
                "set-cookie": "auth_token=abc; Domain=pi.local; Secure; Path=/",
            });
            res.end("<html><head><title>Pi</title></head><body>PIKVM-UI</body></html>");
        } else if (req.url === "/x.txt") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("plain-passthrough");
        } else {
            res.writeHead(404);
            res.end("nope");
        }
    });
    const piPort = await listen(pi);

    // 2. Control + proxy pointing at the mock, then our minimal server shell.
    const control = new PiKvmControl({ origin: `http://127.0.0.1:${piPort}` });
    const proxy = createPiKvmProxy({ control, htmlInjection: () => webAssets.htmlInjection() });
    const srv = createServer((req, res) => {
        let path = new URL(req.url ?? "/", "http://x").pathname;
        if (path === "/_agent" || path.startsWith("/_agent/")) {
            path = path.slice("/_agent".length) || "/";
            if (req.method === "GET" && webAssets.serve(path, res)) return;
            res.writeHead(404);
            res.end("agent-404");
            return;
        }
        void proxy.handleHttp(req, res);
    });
    const port = await listen(srv);
    const base = `http://127.0.0.1:${port}`;

    // 3. Assertions.
    const checks: Array<[string, boolean]> = [];

    const htmlRes = await fetch(`${base}/`);
    const html = await htmlRes.text();
    checks.push(["proxied Pi HTML present", html.includes("PIKVM-UI")]);
    checks.push(["head injection (viewport)", html.includes("data-pikvm-agent")]);
    checks.push(["body injection (FAB)", html.includes("pikvm-agent-fab")]);
    checks.push(["head inject is before </head>", html.indexOf("data-pikvm-agent") < html.indexOf("</head>")]);
    checks.push(["body inject is before </body>", html.indexOf("pikvm-agent-fab") < html.indexOf("</body>")]);

    const setCookie = htmlRes.headers.getSetCookie().join("; ");
    checks.push(["Set-Cookie Domain stripped", setCookie.length > 0 && !/Domain=/i.test(setCookie)]);
    checks.push(["Set-Cookie Secure stripped on http", !/Secure/i.test(setCookie)]);

    const txt = await (await fetch(`${base}/x.txt`)).text();
    checks.push(["non-HTML passthrough", txt === "plain-passthrough"]);

    const sidebar = await fetch(`${base}/_agent/sidebar.html`);
    checks.push(["/_agent/sidebar.html served", sidebar.status === 200 && (await sidebar.text()).includes("root")]);

    let ok = true;
    for (const [name, pass] of checks) {
        console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
        if (!pass) ok = false;
    }
    srv.close();
    pi.close();
    process.exit(ok ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
