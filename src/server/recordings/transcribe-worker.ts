/**
 * The transcriber's own process (built to dist/transcribe-worker.js, started by transcriber.ts under `nice`, one per job). It
 * reads the recording's two voices with ffmpeg, then:
 *
 *   target   Silero VAD splits it into speech segments; Parakeet recognises each; pyannote segmentation with
 *            WeSpeaker embeddings tells who spoke when; each word takes the speaker it overlaps most.
 *   mic      the same VAD and recogniser; one speaker, "You".
 *
 * Where the two voices are depends on who made the file (`layoutOf`): a recording the host captured has an audio stream named
 * `target` (the Pi's stereo sound, folded to mono) and, when a browser sent a microphone, one named `mic`; a recording an older
 * browser uploaded has ONE stereo stream, the target in its left channel and the person in its right.
 *
 * All through sherpa-onnx-node (CPU, onnxruntime inside). It opens no socket and makes no request; the models are files.
 *
 * Messages (JSON over the IPC channel):
 *   parent -> worker  { file, workDir, modelsDir, threads, maxSeconds }
 *   worker -> parent  { type: "progress", value }          0..1, only ever up
 *                     { type: "decoded", durationSeconds } once the audio is decoded: the parent sets its time limit from it
 *                     { type: "done", durationMs, segments, speakers, text, tookSeconds }
 *                     { type: "error", message }
 * When the parent goes away the worker stops, and its ffmpeg with it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptSegment } from "@pikvm/contracts/recordings";
import { asrModelPaths, type AsrModelPaths } from "./asr-models";
import { probeMedia, type MediaFacts } from "./media";
import { segmentsOf, smoothSpeakers, speakersOfWords, transcriptText, wordsOf, type RawSegment, type SpeakerSpan, type Word } from "./transcript";

const SAMPLE_RATE = 16_000;
/** Silero VAD's window at 16 kHz, in samples. */
const VAD_WINDOW = 512;

/** The slice of sherpa-onnx-node this worker uses (the package ships JSDoc, not types). */
interface Sherpa {
    OfflineRecognizer: new (config: object) => Recognizer;
    OfflineSpeakerDiarization: new (config: object) => { process(samples: Float32Array): SpeakerSpan[] };
    Vad: new (config: object, bufferSeconds: number) => Vad;
}
interface Recognizer {
    createStream(): { acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void };
    decode(stream: object): void;
    getResult(stream: object): { text: string; tokens: string[]; timestamps: number[]; durations?: number[] };
}
interface Vad {
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(): { start: number; samples: Float32Array };
    pop(): void;
    flush(): void;
}

interface Job {
    file: string;
    workDir: string;
    modelsDir: string;
    threads: number;
    clusterThreshold: number;
    maxSeconds: number;
}

const send = (message: object, then?: () => void): void => void process.send?.(message, undefined, undefined, then);
/** Sends and resolves once the message has left this process, so exiting after it cannot lose it. */
function sendAndWait(message: object): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    send(message, resolve);
    return promise;
}
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const running = new Set<ChildProcess>();
const stopAll = (): void => {
    for (const child of running) child.kill("SIGKILL");
};
process.on("exit", stopAll);
// The host went away (or killed this process's parent): nothing is waiting for the answer.
process.on("disconnect", () => process.exit(1));

/** Where a voice is in the file: the audio stream (counted among the audio streams) and the filter that makes it mono. */
interface Voice {
    stream: number;
    filter: string;
}

const FOLD_STEREO = "pan=mono|c0=0.5*c0+0.5*c1";
const LEFT = "pan=mono|c0=c0";
const RIGHT = "pan=mono|c0=c1";

/** The target's and the person's voice in this file; null for a voice it does not hold. */
export function layoutOf(facts: MediaFacts | null): { target: Voice | null; mic: Voice | null } {
    const streams = facts?.audioStreams ?? [];
    const targetAt = streams.findIndex((s) => s.name === "target");
    const micAt = streams.findIndex((s) => s.name === "mic");
    if (targetAt >= 0 || micAt >= 0) {
        return {
            target: targetAt >= 0 ? { stream: targetAt, filter: (streams[targetAt]?.channels ?? 1) >= 2 ? FOLD_STEREO : LEFT } : null,
            mic: micAt >= 0 ? { stream: micAt, filter: LEFT } : null,
        };
    }
    // An older browser recording: one stereo stream, LEFT the target and RIGHT the person (a mono one is the target alone).
    const stereo = facts === null || (streams[0]?.channels ?? 0) >= 2;
    return { target: { stream: 0, filter: LEFT }, mic: stereo ? { stream: 0, filter: RIGHT } : null };
}

/** One voice of the recording, as 16 kHz mono 32-bit float, in a file. */
async function decodeVoice(file: string, voice: Voice, out: string): Promise<void> {
    const args = ["-nostdin", "-v", "error", "-i", file, "-vn", "-sn", "-dn", "-map", `0:a:${voice.stream}`, "-af", voice.filter, "-ar", String(SAMPLE_RATE), "-f", "f32le", "-y", out];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    running.add(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    child.on("error", (error) => reject(new Error(`ffmpeg could not start: ${error.message}`)));
    child.on("close", (code) => {
        running.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg failed decoding audio stream ${voice.stream}: ${stderr.trim().split("\n").pop() ?? `exit ${code}`}`));
    });
    return promise;
}

/** The whole file as samples, in one allocation. */
function loadSamples(path: string): Float32Array {
    const bytes = statSync(path).size - (statSync(path).size % 4);
    const samples = new Float32Array(bytes / 4);
    const view = new Uint8Array(samples.buffer, 0, bytes);
    const fd = openSync(path, "r");
    try {
        let read = 0;
        while (read < bytes) {
            const n = readSync(fd, view, read, bytes - read, read);
            if (n === 0) break;
            read += n;
        }
    } finally {
        closeSync(fd);
    }
    return samples;
}

async function main(job: Job): Promise<void> {
    const started = performance.now();
    const sherpa = require("sherpa-onnx-node") as Sherpa;
    const models: AsrModelPaths = asrModelPaths(job.modelsDir);
    mkdirSync(job.workDir, { recursive: true, mode: 0o700 });

    const facts = await probeMedia(job.file);
    if (facts && !facts.hasAudio) throw new Error("This recording has no audio track to transcribe.");
    const layout = layoutOf(facts);
    const hasMic = layout.mic !== null;

    const targetFile = join(job.workDir, "target.f32");
    const micFile = join(job.workDir, "mic.f32");
    if (layout.target) await decodeVoice(job.file, layout.target, targetFile);
    else writeFileSync(targetFile, "");
    if (layout.mic) await decodeVoice(job.file, layout.mic, micFile);
    const targetLength = statSync(targetFile).size / 4;
    const micLength = hasMic ? statSync(micFile).size / 4 : 0;
    const durationSeconds = Math.max(targetLength, micLength) / SAMPLE_RATE;
    if (durationSeconds > job.maxSeconds) {
        throw new Error(`This recording is ${Math.round(durationSeconds / 60)} minutes long; the host transcribes at most ${Math.round(job.maxSeconds / 60)}.`);
    }
    send({ type: "decoded", durationSeconds });
    send({ type: "progress", value: 0.04 });

    const recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
            transducer: { encoder: models.encoder, decoder: models.decoder, joiner: models.joiner },
            modelType: "nemo_transducer",
            tokens: models.tokens,
            numThreads: job.threads,
            provider: "cpu",
            debug: 0,
        },
    });
    const newVad = (): Vad =>
        new sherpa.Vad(
            { sileroVad: { model: models.vad, threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 }, sampleRate: SAMPLE_RATE, numThreads: 1, provider: "cpu", debug: 0 },
            60,
        );

    /** Speech segments of one channel, recognised, with words timed from the start of the recording. */
    async function recognise(samples: Float32Array, from: number, to: number): Promise<Word[][]> {
        const vad = newVad();
        const out: Word[][] = [];
        const drain = (): void => {
            while (!vad.isEmpty()) {
                const segment = vad.front();
                vad.pop();
                const stream = recognizer.createStream();
                stream.acceptWaveform({ samples: segment.samples, sampleRate: SAMPLE_RATE });
                recognizer.decode(stream);
                const result = recognizer.getResult(stream);
                const words = wordsOf(result.tokens, result.timestamps, result.durations ?? [], segment.start / SAMPLE_RATE);
                if (words.length > 0) out.push(words);
            }
        };
        // The VAD must be fed one window (512 samples) at a time: handed a second of audio in one call it places segments up to a second
        // late and loses the first words of each (measured in the E2E). A second's worth of windows, then the event loop and a progress report.
        const second = Math.floor(SAMPLE_RATE / VAD_WINDOW) * VAD_WINDOW;
        for (let at = 0; at < samples.length; at += second) {
            const end = Math.min(samples.length, at + second);
            for (let w = at; w < end; w += VAD_WINDOW) {
                vad.acceptWaveform(samples.subarray(w, Math.min(end, w + VAD_WINDOW)));
                drain();
            }
            send({ type: "progress", value: from + ((to - from) * end) / Math.max(1, samples.length) });
            await yieldToLoop();
        }
        vad.flush();
        drain();
        return out;
    }

    // Diarize the target channel first: one blocking call, the one stretch with no progress to report.
    let spans: SpeakerSpan[] = [];
    let target: Float32Array | null = loadSamples(targetFile);
    if (targetLength >= SAMPLE_RATE) {
        const diarizer = new sherpa.OfflineSpeakerDiarization({
            segmentation: { pyannote: { model: models.segmentation }, numThreads: job.threads, provider: "cpu", debug: 0 },
            embedding: { model: models.embedding, numThreads: job.threads, provider: "cpu", debug: 0 },
            clustering: { numClusters: -1, threshold: job.clusterThreshold },
            minDurationOn: 0.3,
            minDurationOff: 0.5,
        });
        spans = diarizer.process(target);
    }
    send({ type: "progress", value: 0.15 });

    const asrEnd = hasMic ? 0.6 : 0.97;
    const targetRaw = await recognise(target, 0.15, asrEnd);
    target = null;
    const targetSegments: RawSegment[] = targetRaw.map((words) => ({ words, speakers: smoothSpeakers(speakersOfWords(words, spans)) }));

    let micRaw: Word[][] = [];
    if (hasMic) {
        const mic = loadSamples(micFile);
        micRaw = await recognise(mic, asrEnd, 0.97);
    }

    // Raw speaker ids become "Speaker 1", "Speaker 2" ... in the order they first speak in the transcript.
    const names = new Map<number, string>();
    const sorted = [...targetSegments].sort((a, b) => (a.words[0]?.start ?? 0) - (b.words[0]?.start ?? 0));
    for (const segment of sorted) for (const id of segment.speakers) if (!names.has(id)) names.set(id, `Speaker ${names.size + 1}`);
    const segments: TranscriptSegment[] = [
        ...segmentsOf(targetSegments, "target", (id) => names.get(id) ?? "Speaker 1"),
        ...segmentsOf(
            micRaw.map((words) => ({ words, speakers: words.map(() => 0) })),
            "mic",
            () => "You",
        ),
    ].sort((a, b) => a.start - b.start || a.end - b.end);
    const speakers = [...new Set(segments.map((s) => s.speaker))];
    await sendAndWait({
        type: "done",
        durationMs: Math.round(durationSeconds * 1000),
        segments,
        speakers,
        text: transcriptText(segments),
        tookSeconds: Math.round(((performance.now() - started) / 1000) * 10) / 10,
    });
}

process.once("message", (job: Job) => {
    main(job).then(
        () => process.exit(0),
        (error: unknown) => {
            // The process leaves once the message has.
            send({ type: "error", message: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
        },
    );
});
