import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The models the transcriber loads, as files under one directory (`PIKVM_ASR_MODELS`, image default /opt/asr/models). The image
 * fetches them at build time against deploy/asr.lock (scripts/fetch-asr.mjs) and the running host never downloads anything.
 */
export const ASR_MODEL_FILES = {
    encoder: "parakeet-tdt-110m/encoder.int8.onnx",
    decoder: "parakeet-tdt-110m/decoder.int8.onnx",
    joiner: "parakeet-tdt-110m/joiner.int8.onnx",
    tokens: "parakeet-tdt-110m/tokens.txt",
    vad: "silero_vad.onnx",
    segmentation: "pyannote-segmentation-3.0.int8.onnx",
    embedding: "3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx",
} as const;

/** What the page and every transcript call the models. */
export const ASR_MODEL_NAMES = {
    recognizer: "NVIDIA Parakeet TDT 110M (English, int8) with Silero VAD",
    diarizer: "pyannote segmentation 3.0 with 3D-Speaker ERes2Net speaker embeddings",
} as const;

/**
 * How fast the diarizer's clustering joins voices: a larger threshold joins more of them into one speaker. 0.85 is in the middle
 * of the range (0.8 to 0.9) that found exactly two speakers in the E2E fixture; two real two-speaker recordings from the
 * sherpa-onnx test set gave two speakers from 0.6 to 0.9. `PIKVM_ASR_SPEAKER_THRESHOLD` overrides it.
 */
export const DEFAULT_CLUSTER_THRESHOLD = 0.85;

export type AsrModelPaths = { -readonly [K in keyof typeof ASR_MODEL_FILES]: string };

export function asrModelPaths(dir: string): AsrModelPaths {
    const paths = {} as AsrModelPaths;
    for (const key of Object.keys(ASR_MODEL_FILES) as (keyof typeof ASR_MODEL_FILES)[]) paths[key] = join(dir, ASR_MODEL_FILES[key]);
    return paths;
}

/** The model files that are not in the directory, by name. */
export function missingAsrModels(dir: string): string[] {
    return Object.values(ASR_MODEL_FILES).filter((name) => !existsSync(join(dir, name)));
}
