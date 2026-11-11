/**
 * The Nemotron diarizer's pure parts: the environment switch, the install check, the WAV the engine reads, and the engine's JSON, which
 * must fit the span shape exactly or the worker falls back to sherpa. The engine itself is not run here (it takes minutes on a real
 * recording); the bakeoff fixtures measure it.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diarizeWithNemotron, NEMOTRON_MODEL_FILE, nemotronProblem, parseDiarizer, parseNemotronSpans, writePcm16Wav } from "../src/server/recordings/nemotron-diarizer";

test("PIKVM_ASR_DIARIZER: unset, empty or sherpa keeps sherpa; nemotron opts in; anything else is refused", () => {
    assert.equal(parseDiarizer(undefined), "sherpa");
    assert.equal(parseDiarizer(""), "sherpa");
    assert.equal(parseDiarizer("sherpa"), "sherpa");
    assert.equal(parseDiarizer("nemotron"), "nemotron");
    assert.throws(() => parseDiarizer("Nemotron"), /PIKVM_ASR_DIARIZER must be "sherpa" or "nemotron", not "Nemotron"/);
    assert.throws(() => parseDiarizer("pyannote"), /not "pyannote"/);
});

test("the install check names what is missing: the model, then the executable engine", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemotron-problem-"));
    try {
        assert.match(nemotronProblem(dir) ?? "", /The Nemotron model .* is not in /);
        writeFileSync(join(dir, NEMOTRON_MODEL_FILE), "gguf");
        assert.match(nemotronProblem(dir) ?? "", /The Nemotron engine .* is not installed or not executable/);
        mkdirSync(join(dir, "bin"));
        const engine = join(dir, "bin", "nemo-speech");
        writeFileSync(engine, "#!/bin/sh\n");
        chmodSync(engine, 0o644);
        assert.match(nemotronProblem(dir) ?? "", /not installed or not executable/);
        chmodSync(engine, 0o755);
        assert.equal(nemotronProblem(dir), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("writePcm16Wav writes a 44-byte header and clamped little-endian PCM16 over more than one chunk", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemotron-wav-"));
    try {
        const file = join(dir, "in.wav");
        // 16,001 samples: one full one-second chunk and a one-sample tail; values past [-1, 1] are clamped.
        const samples = new Float32Array(16_001);
        samples[0] = 1;
        samples[1] = -1;
        samples[2] = 2;
        samples[3] = -2;
        samples[4] = 0.5;
        samples[16_000] = -0.5;
        writePcm16Wav(file, samples, 16_000);
        const wav = readFileSync(file);
        assert.equal(wav.length, 44 + 16_001 * 2);
        assert.equal(wav.toString("ascii", 0, 4), "RIFF");
        assert.equal(wav.readUInt32LE(4), 36 + 16_001 * 2);
        assert.equal(wav.toString("ascii", 8, 12), "WAVE");
        assert.equal(wav.readUInt16LE(20), 1, "PCM");
        assert.equal(wav.readUInt16LE(22), 1, "mono");
        assert.equal(wav.readUInt32LE(24), 16_000, "sample rate");
        assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
        assert.equal(wav.toString("ascii", 36, 40), "data");
        assert.equal(wav.readUInt32LE(40), 16_001 * 2);
        assert.equal(wav.readInt16LE(44), 32767);
        assert.equal(wav.readInt16LE(46), -32768);
        assert.equal(wav.readInt16LE(48), 32767, "clamped above 1");
        assert.equal(wav.readInt16LE(50), -32768, "clamped below -1");
        assert.equal(wav.readInt16LE(52), Math.round(0.5 * 0x7fff));
        assert.equal(wav.readInt16LE(44 + 16_000 * 2), Math.round(-0.5 * 0x8000), "the tail chunk is written too");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the engine's JSON becomes sherpa-style spans: speakers from 0, ordered by start", () => {
    const json = JSON.stringify({
        segments: [
            { start: 2.5, end: 4, speaker: 2 },
            { start: 0, end: 2.5, speaker: 1 },
        ],
    });
    assert.deepEqual(parseNemotronSpans(json), [
        { start: 0, end: 2.5, speaker: 0 },
        { start: 2.5, end: 4, speaker: 1 },
    ]);
    assert.deepEqual(parseNemotronSpans(JSON.stringify({ segments: [] })), []);
});

test("anything that does not fit the span shape is an error, so the worker falls back to sherpa", () => {
    const bad: Array<[string, string, RegExp]> = [
        ["not JSON", "{", /not JSON/],
        ["no segments list", "{}", /no segments list/],
        ["segments not a list", '{"segments":{}}', /no segments list/],
        ["a missing field", '{"segments":[{"start":0,"end":1}]}', /without numeric start, end and speaker/],
        ["a string field", '{"segments":[{"start":"0","end":1,"speaker":1}]}', /without numeric/],
        ["an end before its start", '{"segments":[{"start":2,"end":1,"speaker":1}]}', /invalid segment/],
        ["a non-finite time", '{"segments":[{"start":0,"end":1e999,"speaker":1}]}', /invalid segment/],
        ["speaker zero", '{"segments":[{"start":0,"end":1,"speaker":0}]}', /invalid segment/],
        ["a fractional speaker", '{"segments":[{"start":0,"end":1,"speaker":1.5}]}', /invalid segment/],
        ["a null entry", '{"segments":[null]}', /without numeric/],
    ];
    for (const [name, json, message] of bad) {
        assert.throws(() => parseNemotronSpans(json), message, name);
    }
});

function fakeEngine(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "nemotron-engine-"));
    writeFileSync(join(dir, NEMOTRON_MODEL_FILE), "gguf");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "nemo-speech"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "bin", "nemo-speech"), 0o755);
    return dir;
}

test("a hung engine is killed at the timeout and the run rejects, so the worker can fall back", async () => {
    const dir = fakeEngine("exec sleep 30");
    try {
        let child: { pid?: number; killed: boolean } | undefined;
        const started = Date.now();
        await assert.rejects(diarizeWithNemotron(dir, join(dir, "in.wav"), join(dir, "out.json"), 1, 300, (c) => (child = c)), /did not finish within 0 s and was stopped|did not finish within \d+ s/);
        assert.ok(Date.now() - started < 5_000, "the timeout, not the engine, ended the run");
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(child?.pid !== undefined && !processAlive(child.pid), "the engine process is gone");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an engine that exits non-zero rejects with its last stderr line (a CPU without AVX2 dies this way)", async () => {
    const dir = fakeEngine("echo 'Illegal instruction' >&2\nexit 132");
    try {
        await assert.rejects(diarizeWithNemotron(dir, join(dir, "in.wav"), join(dir, "out.json"), 1, 10_000, () => undefined), /The Nemotron engine failed: Illegal instruction/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an engine that exits cleanly with output that does not parse rejects", async () => {
    // The engine writes its output to the -o file; this fake leaves a file that is not JSON there and exits 0.
    const dir = fakeEngine("exit 0");
    try {
        const out = join(dir, "out.json");
        writeFileSync(out, "not json");
        await assert.rejects(diarizeWithNemotron(dir, join(dir, "in.wav"), out, 1, 10_000, () => undefined), /JSON|json|segments/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
