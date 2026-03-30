import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, totalmem } from "node:os";

import { env, pipeline } from "@huggingface/transformers";

import { extractAudioToWav, getVideoDurationMs } from "./ffmpeg.js";
import type { RawSubtitleCue, SubtitleBuildResult } from "../types.js";

type StatusCallback = (message: string) => void;

const SMALL_MODEL = "onnx-community/whisper-tiny_timestamped";
const LARGE_MODEL = "onnx-community/whisper-base_timestamped";

let transcriberPromise: Promise<any> | null = null;
let transcriberModel = "";

function chooseModel() {
  const memoryGb = totalmem() / 1024 / 1024 / 1024;
  return memoryGb >= 2 ? LARGE_MODEL : SMALL_MODEL;
}

async function getTranscriber(onStatus?: StatusCallback) {
  const modelId = chooseModel();
  if (transcriberPromise && transcriberModel === modelId) {
    return transcriberPromise;
  }

  transcriberModel = modelId;
  transcriberPromise = (async () => {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;

    onStatus?.(`Loading Whisper model: ${modelId}`);
    return pipeline("automatic-speech-recognition", modelId);
  })();

  return transcriberPromise;
}

function cleanTranscriptText(text: string) {
  return text.replace(/\s+/g, " ").replace(/<\|[^>]+?\|>/g, "").trim();
}

function normalizeCues(chunks: Array<{ text?: string; timestamp?: [number, number] }>, durationMs: number): RawSubtitleCue[] {
  const cues: RawSubtitleCue[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const text = cleanTranscriptText(chunk.text ?? "");
    if (!text) {
      continue;
    }

    const startSec = Array.isArray(chunk.timestamp) && Number.isFinite(chunk.timestamp[0]) ? chunk.timestamp[0] : index * 2;
    const endSec =
      Array.isArray(chunk.timestamp) && Number.isFinite(chunk.timestamp[1]) ? chunk.timestamp[1] : Math.min(durationMs / 1000, startSec + 3);

    const startMs = Math.max(0, Math.round(startSec * 1000));
    const endMs = Math.max(startMs + 500, Math.round(endSec * 1000));
    cues.push({ startMs, endMs, text });
  }

  if (cues.length > 0) {
    return cues;
  }

  return [
    {
      startMs: 0,
      endMs: durationMs,
      text: "字幕生成失败，请尝试提供外部字幕文件。",
    },
  ];
}

export async function generateSubtitleCuesFromVideo(inputPath: string, onStatus?: StatusCallback): Promise<SubtitleBuildResult> {
  const durationMs = await getVideoDurationMs(inputPath);
  const tempDir = await mkdtemp(join(tmpdir(), "anime-learning-slicer-"));
  const wavPath = join(tempDir, "audio.wav");

  try {
    onStatus?.("Extracting audio track...");
    await extractAudioToWav(inputPath, wavPath);

    onStatus?.("Running Whisper transcription...");
    const transcriber = await getTranscriber(onStatus);
    const output = await transcriber(wavPath, {
      return_timestamps: true,
      chunk_length_s: 24,
      stride_length_s: 4,
      force_full_sequences: false,
      language: "japanese",
      task: "transcribe",
    });

    const chunks =
      Array.isArray(output?.chunks) && output.chunks.length > 0
        ? output.chunks
        : [
            {
              text: output?.text ?? "",
              timestamp: [0, Math.max(1, Math.round(durationMs / 1000))] as [number, number],
            },
          ];

    return {
      source: "auto",
      modelLabel: transcriberModel,
      cues: normalizeCues(chunks, durationMs),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
