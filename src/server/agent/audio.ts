import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import OpusScript from "opusscript";
import type { DeskTarget } from "./desk";

export interface AudioClip {
    readonly wav: Buffer;
    readonly durationMs: number;
}

/** Receive only. Never requests a microphone or stops another Janus handle. */
export async function listenToTarget(target: DeskTarget, durationMs: number, signal: AbortSignal): Promise<AudioClip> {
    signal.throwIfAborted();
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 30_000) {
        throw new Error("Audio duration must be between 100 and 30000 milliseconds.");
    }
    const url = new URL("/janus/ws", target.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, "janus-protocol", {
        headers: target.headers,
        rejectUnauthorized: target.rejectUnauthorized,
    });
    const peer = new RTCPeerConnection({
        codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 })] },
        iceServers: [],
    });
    const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    const result = Promise.withResolvers<AudioClip>();
    const chunks: Buffer[] = [];
    const maxBytes = Math.round(durationMs * 48) * 4;
    let bytes = 0;
    let sessionId: number | undefined;
    let handleId: number | undefined;
    let captureTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const send = (janus: string, fields: Record<string, unknown> = {}): void => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ janus, transaction: randomUUID(), session_id: sessionId, ...fields }));
        }
    };
    const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        result.reject(error instanceof Error ? error : new Error(String(error)));
    };
    const finish = (): void => {
        if (settled) return;
        if (!bytes) return fail(new Error("The PiKVM sent no audio packets."));
        settled = true;
        const pcm = Buffer.concat(chunks, bytes);
        const wav = Buffer.allocUnsafe(44 + pcm.length);
        wav.write("RIFF", 0);
        wav.writeUInt32LE(36 + pcm.length, 4);
        wav.write("WAVEfmt ", 8);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(2, 22);
        wav.writeUInt32LE(48000, 24);
        wav.writeUInt32LE(192000, 28);
        wav.writeUInt16LE(4, 32);
        wav.writeUInt16LE(16, 34);
        wav.write("data", 36);
        wav.writeUInt32LE(pcm.length, 40);
        pcm.copy(wav, 44);
        result.resolve({ wav, durationMs: pcm.length / 192 });
    };
    peer.onTrack.subscribe((track) => {
        if (track.kind !== "audio") return;
        track.onReceiveRtp.subscribe((packet) => {
            if (settled) return;
            try {
                const decoded = decoder.decode(packet.payload);
                const pcm = decoded.subarray(0, maxBytes - bytes);
                chunks.push(Buffer.from(pcm));
                bytes += pcm.length;
                if (!captureTimer) captureTimer = setTimeout(finish, durationMs);
                if (bytes >= maxBytes) finish();
            } catch (error) {
                fail(error);
            }
        });
    });
    peer.onIceCandidate.subscribe((candidate) => send("trickle", {
        handle_id: handleId,
        candidate: candidate ? candidate.toJSON() : { completed: true },
    }));
    peer.connectionStateChange.subscribe((state) => {
        if (state === "failed") fail(new Error("The PiKVM audio connection failed."));
    });
    const message = (body: Record<string, unknown>, jsep?: unknown): void => {
        send("message", { handle_id: handleId, body, ...(jsep ? { jsep } : {}) });
    };
    const onMessage = async (raw: WebSocket.RawData): Promise<void> => {
        const event = JSON.parse(raw.toString());
        if (event.janus === "error") throw new Error(event.error?.reason ?? "Janus rejected the audio session.");
        if (event.janus === "success" && event.data?.id) {
            if (!sessionId) {
                sessionId = event.data.id;
                send("attach", { plugin: "janus.plugin.ustreamer" });
            } else if (!handleId) {
                handleId = event.data.id;
                message({ request: "features" });
            }
        }
        const data = event.plugindata?.data;
        if (data?.error || data?.error_code) throw new Error(data.error ?? "The PiKVM rejected audio capture.");
        if (data?.result?.status === "features") {
            if (!data.result.features?.audio) throw new Error("This PiKVM does not provide audio.");
            message({ request: "watch", params: { orientation: 0, audio: true, mic: false, cam: false } });
        }
        if (event.jsep) {
            await peer.setRemoteDescription(event.jsep);
            for (const transceiver of peer.getTransceivers()) {
                transceiver.direction = transceiver.kind === "audio" ? "recvonly" : "inactive";
            }
            await peer.setLocalDescription(await peer.createAnswer());
            message({ request: "start" }, peer.localDescription);
        }
        if (event.janus === "trickle") await peer.addIceCandidate(event.candidate?.completed ? undefined : event.candidate);
        if (event.janus === "hangup" || event.janus === "detached") throw new Error("The PiKVM ended the audio session.");
    };
    socket.on("open", () => send("create"));
    socket.on("message", (raw) => { void onMessage(raw).catch(fail); });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("The PiKVM audio socket closed.")));
    const abort = (): void => fail(signal.reason ?? new Error("Audio capture cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => fail(new Error("Timed out waiting for PiKVM audio.")), durationMs + 15_000);
    const keepalive = setInterval(() => { if (sessionId) send("keepalive"); }, 10_000);
    try {
        signal.throwIfAborted();
        return await result.promise;
    } finally {
        settled = true;
        clearTimeout(deadline);
        clearTimeout(captureTimer);
        clearInterval(keepalive);
        signal.removeEventListener("abort", abort);
        if (sessionId) send("destroy");
        socket.terminate();
        await peer.close();
        decoder.delete();
    }
}
