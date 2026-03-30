import { access, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, join, resolve } from "node:path";

import { Command } from "commander";

import { generateSubtitleCuesFromVideo } from "./lib/asr.js";
import { ensureDirectory, sliceVideoFile } from "./lib/ffmpeg.js";
import { buildSlicePlan } from "./lib/slicer.js";
import { parseSubtitleFile, writeVttFile } from "./lib/subtitles.js";
import type { ClipOutput, SliceManifest, SliceOptions, SubtitleBuildResult } from "./types.js";

function slugify(input: string, fallback: string) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || fallback;
}

async function ensureFileExists(pathValue: string) {
  await access(pathValue, fsConstants.F_OK);
}

function parseIntegerOption(value: string, label: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

async function resolveSubtitleBuild(inputPath: string, subtitlePath?: string) {
  if (subtitlePath) {
    const cues = await parseSubtitleFile(subtitlePath);
    if (cues.length === 0) {
      throw new Error("The subtitle file was parsed successfully, but no usable Japanese cues were found.");
    }

    return {
      source: "external",
      cues,
    } satisfies SubtitleBuildResult;
  }

  return generateSubtitleCuesFromVideo(inputPath, (message) => {
    console.log(`[asr] ${message}`);
  });
}

async function exportClips(inputPath: string, outputDir: string, subtitleBuild: SubtitleBuildResult, plan: Awaited<ReturnType<typeof buildSlicePlan>>, options: SliceOptions) {
  const clipsDir = join(outputDir, "clips");
  await ensureDirectory(clipsDir);

  const exported: ClipOutput[] = [];

  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = plan.clips[index];
    const baseName = `${String(index + 1).padStart(2, "0")}-${slugify(clip.clipTitle, `clip-${index + 1}`)}`;
    const videoPath = join(clipsDir, `${baseName}.mp4`);
    const subtitlePath = join(clipsDir, `${baseName}.vtt`);
    const metadataPath = join(clipsDir, `${baseName}.json`);

    console.log(`[slice] Rendering ${basename(videoPath)} (${Math.round(clip.durationMs / 1000)}s)`);
    await sliceVideoFile(inputPath, videoPath, clip.startMs, clip.endMs);
    await writeVttFile(subtitlePath, clip.segments);

    const metadata: ClipOutput = {
      id: clip.id,
      animeTitle: options.animeTitle,
      episodeTitle: options.episodeTitle,
      clipTitle: clip.clipTitle,
      startMs: clip.startMs,
      endMs: clip.endMs,
      durationMs: clip.durationMs,
      videoPath,
      subtitlePath,
      metadataPath,
      transcriptJa: clip.transcriptJa,
      transcriptZh: clip.transcriptZh,
      subtitleSource: subtitleBuild.source,
      exampleJa: clip.exampleJa,
      exampleZh: clip.exampleZh,
      keyNotes: clip.keyNotes,
      keywords: clip.keywords,
      knowledgePoints: clip.knowledgePoints,
      segments: clip.segments,
    };

    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    exported.push(metadata);
  }

  return exported;
}

async function runSliceCommand(options: {
  input: string;
  anime: string;
  episode?: string;
  subtitle?: string;
  output?: string;
  minClips: string;
  maxClips: string;
  minDuration: string;
  maxDuration: string;
}) {
  const inputPath = resolve(options.input);
  const subtitlePath = options.subtitle ? resolve(options.subtitle) : undefined;
  const outputDir = resolve(options.output ?? join(process.cwd(), "output", slugify(options.anime, "anime-study")));

  await ensureFileExists(inputPath);
  if (subtitlePath) {
    await ensureFileExists(subtitlePath);
  }

  const sliceOptions: SliceOptions = {
    animeTitle: options.anime,
    episodeTitle: options.episode,
    minClips: parseIntegerOption(options.minClips, "min-clips"),
    maxClips: parseIntegerOption(options.maxClips, "max-clips"),
    minDurationSec: parseIntegerOption(options.minDuration, "min-duration"),
    maxDurationSec: parseIntegerOption(options.maxDuration, "max-duration"),
    outputDir,
    inputPath,
  };

  if (sliceOptions.minClips <= 0 || sliceOptions.maxClips < sliceOptions.minClips) {
    throw new Error("Clip count options are invalid.");
  }

  if (sliceOptions.minDurationSec <= 0 || sliceOptions.maxDurationSec < sliceOptions.minDurationSec) {
    throw new Error("Duration options are invalid.");
  }

  await ensureDirectory(outputDir);

  console.log(`[input] ${inputPath}`);
  console.log(`[output] ${outputDir}`);

  const subtitleBuild = await resolveSubtitleBuild(inputPath, subtitlePath);
  console.log(`[subtitle] source=${subtitleBuild.source}${subtitleBuild.modelLabel ? ` model=${subtitleBuild.modelLabel}` : ""} cues=${subtitleBuild.cues.length}`);

  const plan = await buildSlicePlan(sliceOptions, subtitleBuild);
  console.log(`[plan] Generated ${plan.clips.length} study clips.`);

  const exportedClips = await exportClips(inputPath, outputDir, subtitleBuild, plan, sliceOptions);

  const manifest: SliceManifest = {
    animeTitle: sliceOptions.animeTitle,
    episodeTitle: sliceOptions.episodeTitle,
    sourceVideo: inputPath,
    subtitleSource: subtitleBuild.source,
    generatedAt: new Date().toISOString(),
    clipCount: exportedClips.length,
    clips: exportedClips,
  };

  await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[done] Wrote ${exportedClips.length} clips and manifest.`);
}

const program = new Command();

program
  .name("anime-learning-slicer")
  .description("Turn a local anime episode into study-ready clips with subtitles and knowledge metadata.");

program
  .command("slice")
  .requiredOption("--input <path>", "Path to the source episode video.")
  .requiredOption("--anime <title>", "Anime title to store in metadata.")
  .option("--episode <title>", "Episode label to store in metadata.")
  .option("--subtitle <path>", "Optional external subtitle path (.srt, .vtt, .ass).")
  .option("--output <dir>", "Output directory. Defaults to ./output/<anime-title>.")
  .option("--min-clips <count>", "Minimum number of clips.", "5")
  .option("--max-clips <count>", "Maximum number of clips.", "15")
  .option("--min-duration <seconds>", "Minimum duration per clip in seconds.", "10")
  .option("--max-duration <seconds>", "Maximum duration per clip in seconds.", "60")
  .action(async (options) => {
    try {
      await runSliceCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
