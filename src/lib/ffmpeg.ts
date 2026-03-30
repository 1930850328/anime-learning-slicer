import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDirectory(pathValue: string) {
  await mkdir(pathValue, { recursive: true });
}

function resolveBinary(envName: "FFMPEG_BIN" | "FFPROBE_BIN", fallback: "ffmpeg" | "ffprobe") {
  return process.env[envName]?.trim() || fallback;
}

function runBinaryBuffer(command: string, args: string[], label: string) {
  return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(chunks), stderr });
        return;
      }

      reject(new Error(`${label} failed with exit code ${code}.\n${stderr}`));
    });
  });
}

async function runBinary(command: string, args: string[], label: string) {
  const { stdout, stderr } = await runBinaryBuffer(command, args, label);
  return {
    stdout: stdout.toString("utf8"),
    stderr,
  };
}

function formatSeconds(ms: number) {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

function buildCommonEncodeArgs(outputPath: string, videoFilter?: string) {
  const args = [
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  if (videoFilter) {
    args.splice(14, 0, "-vf", videoFilter);
  }

  return args;
}

async function renderSliceAccurate(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
) {
  const ffmpeg = resolveBinary("FFMPEG_BIN", "ffmpeg");

  await runBinary(
    ffmpeg,
    [
      "-y",
      "-fflags",
      "+genpts",
      "-i",
      inputPath,
      "-ss",
      formatSeconds(startMs),
      "-t",
      formatSeconds(endMs - startMs),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-avoid_negative_ts",
      "make_zero",
      ...buildCommonEncodeArgs(outputPath, "scale=trunc(iw/2)*2:trunc(ih/2)*2"),
    ],
    "ffmpeg accurate slice",
  );
}

async function renderSliceFallback(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
) {
  const ffmpeg = resolveBinary("FFMPEG_BIN", "ffmpeg");
  const startSec = formatSeconds(startMs);
  const endSec = formatSeconds(endMs);

  await runBinary(
    ffmpeg,
    [
      "-y",
      "-i",
      inputPath,
      "-filter:v",
      `trim=start=${startSec}:end=${endSec},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      "-filter:a",
      `atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS`,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      ...buildCommonEncodeArgs(outputPath),
    ],
    "ffmpeg fallback slice",
  );
}

async function measureFrameVariance(inputPath: string, atMs: number) {
  const ffmpeg = resolveBinary("FFMPEG_BIN", "ffmpeg");
  const width = 24;
  const height = 14;

  const { stdout } = await runBinaryBuffer(
    ffmpeg,
    [
      "-v",
      "error",
      "-ss",
      formatSeconds(atMs),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:${height},format=rgb24`,
      "-f",
      "rawvideo",
      "-",
    ],
    "ffmpeg frame probe",
  );

  const expectedLength = width * height * 3;
  if (stdout.length < expectedLength) {
    throw new Error(`Could not capture probe frame from ${inputPath}.`);
  }

  let sum = 0;
  let sumSquares = 0;

  for (let index = 0; index < expectedLength; index += 3) {
    const red = stdout[index] ?? 0;
    const green = stdout[index + 1] ?? 0;
    const blue = stdout[index + 2] ?? 0;
    const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
    sum += luma;
    sumSquares += luma * luma;
  }

  const pixels = width * height;
  const mean = sum / pixels;
  const variance = Math.max(0, sumSquares / pixels - mean * mean);
  return Math.sqrt(variance);
}

async function looksLikeSolidColorFailure(
  sourcePath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
) {
  const clipDurationMs = Math.max(1000, endMs - startMs);
  const sampleOffsets = [0.18, 0.5, 0.82].map((ratio) =>
    Math.min(clipDurationMs - 120, Math.max(120, Math.round(clipDurationMs * ratio))),
  );

  const measurements = await Promise.all(
    sampleOffsets.map(async (offsetMs) => {
      const [sourceVariance, outputVariance] = await Promise.all([
        measureFrameVariance(sourcePath, startMs + offsetMs),
        measureFrameVariance(outputPath, offsetMs),
      ]);

      return {
        sourceVariance,
        outputVariance,
      };
    }),
  );

  const sourceHasDetail = measurements.some((item) => item.sourceVariance >= 10);
  const outputLooksFlat = measurements.every((item) => item.outputVariance < 2.8);

  return sourceHasDetail && outputLooksFlat;
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

export async function extractVideoCover(inputPath: string, outputPath: string, atMs: number) {
  const ffmpeg = resolveBinary("FFMPEG_BIN", "ffmpeg");
  await ensureDirectory(dirname(outputPath));

  await runBinary(
    ffmpeg,
    [
      "-y",
      "-ss",
      formatSeconds(atMs),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ],
    "ffmpeg cover extract",
  );
}

export async function sliceVideoFile(inputPath: string, outputPath: string, startMs: number, endMs: number) {
  await ensureDirectory(dirname(outputPath));

  if (endMs <= startMs) {
    throw new Error("Slice end must be greater than slice start.");
  }

  await renderSliceAccurate(inputPath, outputPath, startMs, endMs);

  const suspicious = await looksLikeSolidColorFailure(inputPath, outputPath, startMs, endMs).catch(
    () => false,
  );

  if (!suspicious) {
    return;
  }

  await renderSliceFallback(inputPath, outputPath, startMs, endMs);

  const stillSuspicious = await looksLikeSolidColorFailure(
    inputPath,
    outputPath,
    startMs,
    endMs,
  ).catch(() => false);

  if (stillSuspicious) {
    throw new Error(
      "Rendered clip still looks like a solid-color frame after retry. Please check the source stream or provide a different input file.",
    );
  }
}
