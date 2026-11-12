// A conversation with the deployed image, over HTTP and the chat socket only: no browser.
//
//   node deploy/e2e/chat.e2e.mjs
//
// Environment:
//   HOST_URL       the web host (default http://127.0.0.1:18080)
//   KVMD_URL       the fake kvmd's control API, to read back what reached the "PiKVM" (default http://127.0.0.1:14510)
//   PROVIDER_URL   the fake model's base URL AS THE HOST SEES IT (default http://fake-model:9000/v1)
//
// It adds the scripted model as a provider through the app's settings route, then runs the three things the chat
// has to do end to end: answer, act on the PiKVM (a click lands in the fake kvmd), and ask before a risky key (nothing
// is sent until approved; a denial sends nothing). Exits non-zero on the first failed check.
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const host = process.env.HOST_URL ?? "http://127.0.0.1:18080";
const kvmd = process.env.KVMD_URL ?? "http://127.0.0.1:14510";
const providerUrl = process.env.PROVIDER_URL ?? "http://fake-model:9000/v1";
// The host signs users in itself: the e2e compose sets this access token (E2E_TOKEN overrides it), sent as a bearer.
const token = process.env.E2E_TOKEN ?? "e2e-access-token-0123456789abcdef";
const bearer = { authorization: `Bearer ${token}` };
const api = `${host}/app/chat/api`;

const log = (line) => console.log(line);
const hid = async () => (await (await fetch(`${kvmd}/__fake/hid`)).json()).events;

{
    const put = await fetch(`${api}/settings/agent.providers`, {
        method: "PUT",
        headers: { ...bearer, "content-type": "application/json", "x-chat-request": "1" },
        body: JSON.stringify({
            value: { fake: { enabled: true, baseUrl: providerUrl, api: "openai-completions", apiKey: "sk-e2e", models: [{ id: "fake-1" }] } },
        }),
    });
    assert.equal(put.status, 200, `provider PUT: ${put.status} ${await put.text()}`);
    log("provider added");
}

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${host.replace("http", "ws")}/app/chat/ws`, { headers: { ...bearer, origin: host } });
        const events = [];
        const waiters = [];
        ws.on("message", (data) => {
            const event = JSON.parse(data.toString());
            events.push(event);
            for (const w of [...waiters]) if (w.match(event)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(event));
        });
        ws.once("error", reject);
        ws.once("open", () =>
            resolve({
                events,
                send: (event) => ws.send(JSON.stringify(event)),
                close: () => ws.close(),
                waitFor: (match, ms = 90_000) => {
                    const hit = events.find(match);
                    if (hit) return Promise.resolve(hit);
                    return new Promise((res, rej) => {
                        const t = setTimeout(() => rej(new Error(`timed out; saw ${events.map((e) => e.type).join(", ")}`)), ms);
                        waiters.push({ match, resolve: (e) => (clearTimeout(t), res(e)) });
                    });
                },
            }),
        );
    });
}

const terminal = (e) => /^response\.(completed|failed|incomplete|cancelled)$/.test(e.type);
const text = (events) => events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");

// 1. A foreign Origin is refused.
{
    const outcome = await new Promise((resolve) => {
        const ws = new WebSocket(`${host.replace("http", "ws")}/app/chat/ws`, { headers: { ...bearer, origin: "https://evil.example" } });
        ws.once("open", () => (ws.close(), resolve("open")));
        ws.once("error", () => resolve("refused"));
        ws.once("unexpected-response", () => resolve("refused"));
    });
    assert.equal(outcome, "refused", "a socket from a foreign Origin must be refused");
    log("foreign Origin refused");
}

const c = await connect();
assert.equal(c.events[0]?.type ?? (await c.waitFor(() => true)).type, "chat.hello");

// 2. A reply streams.
{
    const from = c.events.length;
    c.send({ type: "response.create", input: "hello from the image", model: "fake/fake-1" });
    const end = await c.waitFor((e) => terminal(e) && c.events.indexOf(e) >= from);
    assert.equal(end.type, "response.completed");
    assert.equal(text(c.events.slice(from)), "You said: hello from the image");
    log("reply streamed: You said: hello from the image");
}

// 3. A click reaches the PiKVM.
{
    const before = (await hid()).length;
    const from = c.events.length;
    c.send({ type: "response.create", input: "pikvm:click", model: "fake/fake-1" });
    const end = await c.waitFor((e) => terminal(e) && c.events.indexOf(e) >= from);
    assert.equal(end.type, "response.completed");
    const fresh = (await hid()).slice(before);
    assert.ok(fresh.some((e) => /mouse/.test(e.event_type)), `no mouse event reached the fake kvmd: ${JSON.stringify(fresh)}`);
    log(`click arrived at the fake kvmd (${fresh.length} HID events)`);
}

// 4. A risky key asks first; approving sends it, denying does not.
for (const approve of [true, false]) {
    const before = (await hid()).length;
    const from = c.events.length;
    c.send({ type: "response.create", input: "pikvm:approve", model: "fake/fake-1" });
    const ask = await c.waitFor((e) => e.type === "response.output_item.added" && e.item?.type === "mcp_approval_request" && c.events.indexOf(e) >= from);
    const sentWhileAsking = (await hid()).slice(before).filter((e) => e.event_type === "key");
    assert.equal(sentWhileAsking.length, 0, "a key was sent before the person answered");
    const conversation = c.events.slice(from).find((e) => e.type === "response.created").response.conversation.id;
    const mark = c.events.length;
    c.send({ type: "response.create", conversation, input: [{ type: "mcp_approval_response", approval_request_id: ask.item.id, approve }] });
    await c.waitFor((e) => terminal(e) && c.events.indexOf(e) >= mark);
    const keys = (await hid()).slice(before).filter((e) => e.event_type === "key");
    if (approve) assert.ok(keys.length > 0, "an approved chord never arrived");
    else assert.equal(keys.length, 0, "a denied chord arrived anyway");
    log(`approval ${approve ? "approved: chord arrived" : "denied: nothing sent"}`);
}

c.close();
log("OK");
