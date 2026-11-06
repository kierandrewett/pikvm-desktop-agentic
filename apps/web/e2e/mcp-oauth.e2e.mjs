// An MCP client signing in to the host's MCP server with OAuth and using it, in real Chrome against a real web host.
//
//   TOKEN=<access token> node apps/web/e2e/mcp-oauth.e2e.mjs [--out docs/e2e]
//
// The client is this script, written the way the MCP specification says a client behaves: it gets a 401 from /app/mcp, reads
// the resource metadata and the authorization server metadata it points to, registers itself, sends the person to the
// authorization endpoint with PKCE, catches the redirect on a loopback listener and trades the code for a token. Chrome plays
// the person (signs in with the access token, reads the consent page, presses Allow or Cancel). The host is the real
// dist/web-server.js with PIKVM_ACCESS_TOKEN set, in front of tools/fake-kvmd. Bring-up and variables: docs/e2e/README.md.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { WEB, Report, launch } from "./harness.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "docs/e2e";
const TOKEN = process.env.TOKEN ?? "e2e-access-token";
const report = new Report("MCP sign-in with OAuth");
const check = (name, pass, observed) => report.add("host", name, observed, pass);
execFileSync("mkdir", ["-p", `${outDir}/mcp-oauth`]);

// The loopback listener a client uses for its redirect: it keeps the last request it was sent.
let landed;
const listener = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // Chrome also asks for /favicon.ico: only the callback is the client's.
    if (url.pathname === "/callback") landed?.(url);
    res.end("ok");
});
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const REDIRECT = `http://127.0.0.1:${listener.address().port}/callback`;

const b64 = (buf) => buf.toString("base64url");
const pkce = () => {
    const verifier = b64(randomBytes(32));
    return { verifier, challenge: b64(createHash("sha256").update(verifier).digest()) };
};
const rpc = (token, body) =>
    fetch(`${WEB}/app/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 760 });
const shot = (name) => page.screenshot({ path: `${outDir}/mcp-oauth/${name}.png` });

/** Send the person to the authorization endpoint and have Chrome press `decision`; the redirect is what the client's listener saw. */
async function authorize({ clientId, redirect = REDIRECT, state, challenge, decision, shotName }) {
    const seen = new Promise((done) => (landed = done));
    const url = `${WEB}/app/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256" })}`;
    await page.goto(url, { waitUntil: "load" });
    if (await page.$('input[name="token"]')) {
        await page.type('input[name="token"]', TOKEN);
        await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.keyboard.press("Enter")]);
    }
    const heading = await page.$eval("h1", (el) => el.textContent).catch(() => "");
    const text = await page.evaluate(() => document.body.innerText);
    if (shotName) await shot(shotName);
    if (heading !== "Allow this app to control this PiKVM?") return { heading, text };
    await Promise.all([page.waitForNavigation({ waitUntil: "load" }).catch(() => undefined), page.click(`button[value="${decision}"]`)]);
    return { heading, text, redirected: await Promise.race([seen, new Promise((done) => setTimeout(() => done(undefined), 5000))]) };
}

const exchange = (fields) => fetch(`${WEB}/app/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

try {
    // 1. Discovery, as a client does it.
    const refused = await rpc(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const challengeHeader = refused.headers.get("www-authenticate") ?? "";
    check("a request with no credential is refused and says where to sign in", refused.status === 401 && /resource_metadata="[^"]+\.well-known\/oauth-protected-resource\/app\/mcp"/.test(challengeHeader), `HTTP ${refused.status}, ${challengeHeader}`);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challengeHeader)?.[1] ?? `${WEB}/.well-known/oauth-protected-resource/app/mcp`;
    const resource = await (await fetch(metadataUrl)).json();
    check("the resource metadata names this host as the authorization server", resource.resource === `${WEB}/app/mcp` && resource.authorization_servers?.[0] === WEB, JSON.stringify(resource));
    const meta = await (await fetch(`${WEB}/.well-known/oauth-authorization-server`)).json();
    check("the server metadata offers a code flow with PKCE S256, public clients and registration", meta.code_challenge_methods_supported?.join() === "S256" && meta.token_endpoint_auth_methods_supported?.join() === "none" && meta.registration_endpoint === `${WEB}/app/oauth/register` && meta.token_endpoint === `${WEB}/app/oauth/token`, JSON.stringify(meta));

    // 2. Registration.
    const register = (uris) => fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test agent", redirect_uris: uris }) });
    const bad = await register(["http://evil.example/cb"]);
    check("a client cannot register a plain http redirect to another machine", bad.status === 400, `HTTP ${bad.status}`);
    const scripted = await register(["javascript:alert(1)"]);
    check("or a script address", scripted.status === 400, `HTTP ${scripted.status}`);
    const registered = await register([REDIRECT]);
    const client = await registered.json();
    check("a loopback redirect registers, with a client id and no secret", registered.status === 201 && typeof client.client_id === "string" && client.client_secret === undefined, `HTTP ${registered.status}`);

    // 3. The person is asked.
    const state = b64(randomBytes(12));
    let first = pkce();
    const stray = await authorize({ clientId: client.client_id, redirect: "http://127.0.0.1:9/elsewhere", state, challenge: first.challenge, decision: "allow" });
    check("a redirect the client did not register is refused on the page, and nothing is sent to it", stray.redirected === undefined && /not valid/.test(stray.text), stray.text.trim().slice(0, 60));

    const denied = await authorize({ clientId: client.client_id, state, challenge: first.challenge, decision: "deny", shotName: "consent" });
    check("the consent page names the app and where it returns to", denied.heading === "Allow this app to control this PiKVM?" && /Test agent/.test(denied.text) && denied.text.includes(`127.0.0.1:${listener.address().port}`), denied.text.replace(/\s+/g, " ").slice(0, 160));
    check("Cancel sends access_denied with the client's own state", denied.redirected?.searchParams.get("error") === "access_denied" && denied.redirected.searchParams.get("state") === state, denied.redirected?.search ?? "no redirect");

    // 4. Codes: made for one redirect, one use.
    const other = pkce();
    const allowed = await authorize({ clientId: client.client_id, state, challenge: other.challenge, decision: "allow" });
    const code = allowed.redirected?.searchParams.get("code");
    check("Allow sends a code and the state back", typeof code === "string" && allowed.redirected?.searchParams.get("state") === state, allowed.redirected?.search.slice(0, 40) ?? "no redirect");
    const wrongRedirect = await exchange({ grant_type: "authorization_code", code, code_verifier: other.verifier, redirect_uri: "http://127.0.0.1:9/elsewhere", client_id: client.client_id });
    check("a code asked for with another redirect gets nothing", wrongRedirect.status === 400, `HTTP ${wrongRedirect.status}`);
    const spent = await exchange({ grant_type: "authorization_code", code, code_verifier: other.verifier, redirect_uri: REDIRECT, client_id: client.client_id });
    check("and the code is spent by that attempt", spent.status === 400, `HTTP ${spent.status}`);

    first = pkce();
    const second = await authorize({ clientId: client.client_id, state, challenge: first.challenge, decision: "allow" });
    const code2 = second.redirected?.searchParams.get("code");
    const wrongVerifier = await exchange({ grant_type: "authorization_code", code: code2, code_verifier: pkce().verifier, redirect_uri: REDIRECT, client_id: client.client_id });
    check("a wrong PKCE verifier gets nothing", wrongVerifier.status === 400, `HTTP ${wrongVerifier.status}`);

    const third = pkce();
    const last = await authorize({ clientId: client.client_id, state, challenge: third.challenge, decision: "allow" });
    const token = await exchange({ grant_type: "authorization_code", code: last.redirected?.searchParams.get("code"), code_verifier: third.verifier, redirect_uri: REDIRECT, client_id: client.client_id });
    const issued = await token.json();
    check("the right code, verifier and redirect get a bearer token", token.status === 200 && issued.token_type === "Bearer" && /^pkd_[0-9a-f]{12}_/.test(issued.access_token) && issued.access_token !== TOKEN, `HTTP ${token.status}, ${String(issued.access_token).slice(0, 8)}`);

    // 5. The MCP server, with that token.
    const init = await (await rpc(issued.access_token, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } })).json();
    check("initialize answers with the server's name", typeof init.result?.serverInfo?.name === "string", JSON.stringify(init.result?.serverInfo));
    const list = await (await rpc(issued.access_token, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
    const names = (list.result?.tools ?? []).map((t) => t.name);
    check("tools/list offers the PiKVM tools", names.includes("screenshot") && names.includes("click"), names.join(", "));
    const shotCall = await (await rpc(issued.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "screenshot", arguments: {} } })).json();
    const kinds = (shotCall.result?.content ?? []).map((c) => c.type);
    check("a screenshot call returns the picture of the target", !shotCall.result?.isError && kinds.includes("image"), `${kinds.join(", ")}${shotCall.result?.isError ? `, error: ${JSON.stringify(shotCall.result.content).slice(0, 120)}` : ""}`);
    const risky = await (await rpc(issued.access_token, { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "type_text", arguments: { text: "sudo rm -rf /\n" } } })).json();
    const riskyText = JSON.stringify(risky.result?.content ?? risky.error);
    check("a risky action has nobody to ask outside a chat, so it is refused and not done", risky.result?.isError === true && /approval_denied/.test(riskyText) && /Nobody could be asked/.test(riskyText), riskyText.slice(0, 140));
    const notification = await rpc(issued.access_token, { jsonrpc: "2.0", method: "notifications/initialized" });
    check("a notification gets 202 and no body", notification.status === 202, `HTTP ${notification.status}`);
    const batch = await (await rpc(issued.access_token, [{ jsonrpc: "2.0", id: 5, method: "tools/list" }])).json();
    check("a batch is refused", batch.error?.code === -32600, JSON.stringify(batch.error));
    const getStream = await fetch(`${WEB}/app/mcp`, { headers: { authorization: `Bearer ${issued.access_token}` } });
    check("a GET (the optional event stream) is answered 405", getStream.status === 405, `HTTP ${getStream.status}`);
    const withAccess = await rpc(TOKEN, { jsonrpc: "2.0", id: 6, method: "tools/list" });
    check("the access token works on the endpoint too", withAccess.status === 200, `HTTP ${withAccess.status}`);
    const wrong = await rpc("pkd_000000000000_" + "A".repeat(43), { jsonrpc: "2.0", id: 7, method: "tools/list" });
    check("a made-up device token is refused", wrong.status === 401, `HTTP ${wrong.status}`);

    // 6. Settings, Account, and revoking.
    await page.goto(`${WEB}/app/settings/account`, { waitUntil: "load" });
    await page.waitForFunction(() => /Test agent \(MCP\)/.test(document.body.innerText), { timeout: 10000 });
    await shot("account");
    const accountText = await page.evaluate(() => document.body.innerText);
    check("Settings, Account shows the MCP address and the client that signed in", accountText.includes(`${WEB}/app/mcp`) && accountText.includes("Test agent (MCP)"), "address and client listed");
    await page.evaluate(() => {
        for (const b of document.querySelectorAll("button")) if (b.textContent === "Revoke") b.click();
    });
    await page.waitForFunction(() => !/Test agent \(MCP\)/.test(document.body.innerText), { timeout: 10000 });
    const after = await rpc(issued.access_token, { jsonrpc: "2.0", id: 8, method: "tools/list" });
    check("Revoke stops the token working", after.status === 401, `HTTP ${after.status}`);
} catch (error) {
    check("the run finished", false, `threw: ${error.stack ?? error.message}`);
} finally {
    await browser.close();
    listener.close();
}

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const today = new Date().toISOString().slice(0, 10);
const md = [
    "# MCP sign-in with OAuth (end to end)",
    "",
    `Result: ${report.rows.length - report.failed.length} of ${report.rows.length} checks passed.`,
    "",
    "| Check | Result | Observed |",
    "| --- | --- | --- |",
    ...report.rows.map((r) => `| ${r.name} | ${r.pass ? "pass" : "FAIL"} | ${String(r.observed).replace(/\|/g, "/").replace(/\n/g, " ")} |`),
    "",
    "## How this run was made",
    "",
    "```sh",
    `TOKEN=<access token> KVM_WEB=${WEB} PUPPETEER_CORE=${process.env.PUPPETEER_CORE ?? "(default)"} CHROME=${process.env.CHROME ?? "(default)"} \\`,
    "    node apps/web/e2e/mcp-oauth.e2e.mjs",
    "```",
    "",
    `- Repository commit: \`${commit}\` plus the working tree (host built with \`yarn workspace @pikvm/web build && yarn build\`).`,
    `- Node ${process.version}. The host is \`dist/web-server.js\` with \`PIKVM_ACCESS_TOKEN\` set, a scratch data directory and \`tools/fake-kvmd\`. The client is this script; Chrome plays the person.`,
    "- Not covered: a real MCP client (Claude Code, Codex, claude.ai), a real identity provider, a phone, the Electron desktop app.",
    "",
];
writeFileSync(`${outDir}/${today}-mcp-oauth.md`, md.join("\n"));
process.exit(report.failed.length ? 1 : 0);
