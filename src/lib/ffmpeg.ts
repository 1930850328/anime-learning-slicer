import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

export async function ensureDirectory(pathValue: string) {
  await mkdir(pathValue, { recursive: true });
}

function resolveBinary(envName: "FFMPEG_BIN" | "FFPROBE_BIN", fallback: "ffmpeg" | "ffprobe") {
  return process.env[envName]?.trim() || fallback;
}

async function runBinary(command: string, args: string[], label: string) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${label} failed with exit code ${code}.\n${stderr || stdout}`));
    });
  });
}

export async function getVideoDurationMs(inputPath: string) {
  const ffprobePath = resolveBinary("FFPROBE_BIN", "ffprobe");
  const { stdout } = await runBinary(
    ffprobePath,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ],
    "ffprobe",
  );

  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Could not read video duration from ffprobe.");
  }

  return Math.round(seconds * 1000);
}

export async function extractAudioToWav(inputPath: string, outputPath: string) {
  const ffmpeg = resolveBinary("FFMPEG_BIN", "ffmpeg");
  await ensureDirectory(dirname(outputPath));

  await runBinary(
    ffmpeg,
    [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-map",
      "0:a:0?",
      outputPath,
    ],
    "ffmpeg audio extract",
  );
}

export async function sliceVideoFile(inputPath: string, outputPath: string, startMs: number, endMs: number) {
  const ffmpeg = resolveBinary("FFMPEG_BIN", "ffmpeg");
  await ensureDirectory(dirname(outputPath));

  const startSec = (startMs / 1000).toFixed(3);
  const durationSec = ((endMs - startMs) / 1000).toFixed(3);

  await runBinary(
    ffmpeg,
    [
      "-y",
      "-ss",
      startSec,
      "-i",
      inputPath,
      "-t",
      durationSec,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    "ffmpeg slice",
  );
}
