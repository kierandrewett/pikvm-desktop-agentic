/**
 * The agent drives the PiKVM the app is set to.
 *
 * Failure modes, before behaviour:
 *  T1. The daemon is started with no target in its environment, so ~/.config/pikvm-agent/config.yaml
 *      decides (the app shows one PiKVM, the agent acts on another).
 *  T2. A PIKVM_USER / PIKVM_TOKEN left in the shell that launched the app decides instead of the app's own.
 *  T3. The password reaches a process argument (any process can read those) or a log line.
 *  T4. A change in Settings is never handed to the daemon, which reads its target only at start.
 *  T5. A restart is taken for a crash (and counted towards giving up), or leaves two children running.
 *  T6. A service that was adopted, never started, or has been stopped is restarted anyway.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { agentTargetEnvironment, sameAgentTarget } from "../src/agent-target";
import { ManagedService } from "../src/service-manager";

const target = { origin: "https://pikvm.lan:8443/", username: "admin", password: "s3cret-pw" };

test("T1/T2: the app's own target is every variable the daemon reads, with nothing left to the shell's", () => {
    const env = agentTargetEnvironment(target);
    assert.equal(env["PIKVM_BASE_URL"], "https://pikvm.lan:8443");
    assert.equal(env["PIKVM_USER"], "admin");
    assert.equal(env["PIKVM_PASSWORD"], "s3cret-pw");
    // Present and empty, not absent: an absent name falls through to whatever the launching shell had.
    assert.equal(env["PIKVM_TOKEN"], "");
    assert.equal(env["PIKVM_VERIFY_TLS"], "0");
    const none = agentTargetEnvironment({ origin: "https://pikvm/", username: "", password: "" });
    assert.equal(none["PIKVM_USER"], "");
    assert.equal(none["PIKVM_PASSWORD"], "");
    assert.ok("PIKVM_USER" in none && "PIKVM_PASSWORD" in none);
});

test("T3: the password is in one environment variable and no other value", () => {
    const env = agentTargetEnvironment(target);
    const holders = Object.entries(env).filter(([, value]) => value?.includes("s3cret-pw"));
    assert.deepEqual(holders.map(([name]) => name), ["PIKVM_PASSWORD"]);
    // The address carries no credentials either, so a log of it cannot leak them.
    assert.doesNotMatch(String(env["PIKVM_BASE_URL"]), /@|s3cret/);
});

test("T4: only a change the daemon would act on is a change", () => {
    assert.ok(sameAgentTarget(target, { ...target }));
    assert.ok(!sameAgentTarget(target, { ...target, origin: "https://other.lan/" }));
    assert.ok(!sameAgentTarget(target, { ...target, username: "root" }));
    assert.ok(!sameAgentTarget(target, { ...target, password: "new" }));
});

/** A child that reports its environment variable, then stays alive until killed. */
function probe(logs: string[], seen: (line: string) => void): ManagedService {
    return new ManagedService({
        name: "probe",
        origin: "unix:/nonexistent/pikvm-test.sock",
        healthPath: "/healthz",
        command: process.execPath,
        args: ["-e", "console.log('target=' + process.env.PIKVM_BASE_URL + ' pid=' + process.pid); setInterval(() => {}, 1000)"],
        env: { PIKVM_BASE_URL: "https://first.lan", PIKVM_PASSWORD: "s3cret-pw" },
        log: (line) => {
            logs.push(line);
            seen(line);
        },
    });
}

const until = (logs: string[], pattern: RegExp, ms = 8000): Promise<void> =>
    new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
            if (logs.some((l) => pattern.test(l))) return resolve();
            if (Date.now() - t0 > ms) return reject(new Error(`never saw ${pattern}: ${logs.join(" | ")}`));
            setTimeout(tick, 25);
        };
        tick();
    });

test("T4/T5: a restart starts ONE new child on the new environment, and is not a crash", async () => {
    const logs: string[] = [];
    const service = probe(logs, () => {});
    try {
        assert.equal(await service.start(), "started");
        await until(logs, /target=https:\/\/first\.lan pid=\d+/);
        const first = Number(/first\.lan pid=(\d+)/.exec(logs.join("\n"))?.[1]);

        assert.equal(await service.restart({ PIKVM_BASE_URL: "https://second.lan" }), true);
        await until(logs, /target=https:\/\/second\.lan pid=\d+/);
        const second = Number(/second\.lan pid=(\d+)/.exec(logs.join("\n"))?.[1]);

        assert.notEqual(first, second);
        // The old child is gone, the new one is alive.
        assert.throws(() => process.kill(first, 0), /ESRCH/);
        assert.doesNotThrow(() => process.kill(second, 0));
        // Deliberate: no "exited unexpectedly", so no restart count, no second respawn behind its back.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.ok(!logs.some((l) => /exited unexpectedly|giving up/.test(l)), logs.join(" | "));
        assert.equal(logs.filter((l) => /target=\S+ pid=\d+/.test(l)).length, 2);
    } finally {
        service.stop();
    }
});

test("T3: restarting logs what it does, never the environment", async () => {
    const logs: string[] = [];
    const service = probe(logs, () => {});
    try {
        await service.start();
        await until(logs, /target=/);
        await service.restart({ PIKVM_PASSWORD: "another-pw" });
        await until(logs, /restarting/);
        assert.ok(!logs.some((l) => /s3cret-pw|another-pw/.test(l)), "no log line holds a password");
    } finally {
        service.stop();
    }
});

test("T6: nothing of ours to restart means no restart", async () => {
    const never = new ManagedService({ name: "never", origin: "unix:/nonexistent/x.sock", healthPath: "/healthz", command: process.execPath, args: ["-e", ""] });
    assert.equal(await never.restart({ A: "1" }), false);

    const server = createServer((_req, res) => res.writeHead(200).end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const adopted = new ManagedService({
        name: "adopted",
        origin: `http://127.0.0.1:${address.port}`,
        healthPath: "/healthz",
        command: "/definitely/not/a/real/program",
        args: [],
    });
    try {
        assert.equal(await adopted.start(), "adopted");
        assert.equal(await adopted.restart({ A: "1" }), false);
    } finally {
        adopted.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const logs: string[] = [];
    const stopped = probe(logs, () => {});
    await stopped.start();
    await until(logs, /target=/);
    stopped.stop();
    assert.equal(await stopped.restart({ A: "1" }), false);
});
