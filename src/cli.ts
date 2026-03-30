import { access, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import chokidar from "chokidar";
import { Command } from "commander";

import { generateSubtitleCuesFromVideo } from "./lib/asr.js";
import { detectAppDirectory, publishManifestToApp } from "./lib/publish.js";
import { ensureDirectory, extractVideoCover, sliceVideoFile } from "./lib/ffmpeg.js";
import { buildSlicePlan } from "./lib/slicer.js";
import { parseSubtitleFile, writeVttFile } from "./lib/subtitles.js";
import type { ClipOutput, SliceManifest, SliceOptions, SubtitleBuildResult } from "./types.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]);
const SUBTITLE_EXTENSIONS = [".ass", ".srt", ".vtt"];

interface AutoMetadata {
  animeTitle?: string;
  episodeTitle?: string;
  publishedSlug?: string;
  minClips?: number;
  maxClips?: number;
  minDurationSec?: number;
  maxDurationSec?: number;
}

interface SliceCommandOptions {
  input: string;
  anime: string;
  episode?: string;
  subtitle?: string;
  output?: string;
  minClips: string;
  maxClips: string;
  minDuration: string;
  maxDuration: string;
  app?: string;
  publish?: boolean;
  publishedSlug?: string;
}

interface IngestCommandOptions {
  input: string;
  anime?: string;
  episode?: string;
  subtitle?: string;
  metadata?: string;
  output?: string;
  minClips?: string;
  maxClips?: string;
  minDuration?: string;
  maxDuration?: string;
  app?: string;
  publish?: boolean;
  publishedSlug?: string;
}

interface WatchInboxCommandOptions {
  inbox?: string;
  outputRoot?: string;
  app?: string;
  minClips?: string;
  maxClips?: string;
  minDuration?: string;
  maxDuration?: string;
}

interface WatchState {
  processed: Record<string, string>;
}

function slugify(input: string, fallback: string) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || fallback;
}

function humanizeStem(stem: string) {
  return stem
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function basenameWithoutExtension(pathValue: string) {
  const fileName = basename(pathValue);
  const extension = extname(fileName);
  return fileName.slice(0, extension ? -extension.length : undefined);
}

function isVideoFile(pathValue: string) {
  return VIDEO_EXTENSIONS.has(extname(pathValue).toLowerCase());
}

function isSubtitleFile(pathValue: string) {
  return SUBTITLE_EXTENSIONS.includes(extname(pathValue).toLowerCase());
}

async function ensureFileExists(pathValue: string) {
  await access(pathValue, fsConstants.F_OK);
}

async function pathExists(pathValue: string) {
  try {
    await access(pathValue, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseIntegerOption(value: string, label: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

function pickString(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

async function findSidecarSubtitle(inputPath: string) {
  const basePath = join(dirname(inputPath), basenameWithoutExtension(inputPath));
  for (const extension of SUBTITLE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function readAutoMetadata(metadataPath?: string) {
  if (!metadataPath) {
    return {} as AutoMetadata;
  }

  const raw = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object") {
    return {} as AutoMetadata;
  }

  const item = raw as Record<string, unknown>;
  return {
    animeTitle: typeof item.animeTitle === "string" ? item.animeTitle : undefined,
    episodeTitle: typeof item.episodeTitle === "string" ? item.episodeTitle : undefined,
    publishedSlug: typeof item.publishedSlug === "string" ? item.publishedSlug : undefined,
    minClips: typeof item.minClips === "number" ? item.minClips : undefined,
    maxClips: typeof item.maxClips === "number" ? item.maxClips : undefined,
    minDurationSec: typeof item.minDurationSec === "number" ? item.minDurationSec : undefined,
    maxDurationSec: typeof item.maxDurationSec === "number" ? item.maxDurationSec : undefined,
  };
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

async function exportClips(
  inputPath: string,
  outputDir: string,
  subtitleBuild: SubtitleBuildResult,
  plan: Awaited<ReturnType<typeof buildSlicePlan>>,
  options: SliceOptions,
) {
  const clipsDir = join(outputDir, "clips");
  const coversDir = join(outputDir, "covers");
  await Promise.all([ensureDirectory(clipsDir), ensureDirectory(coversDir)]);

  const exported: ClipOutput[] = [];

  for (let index = 0; index < plan.clips.length; index += 1) {
    const clip = plan.clips[index];
    const baseName = `${String(index + 1).padStart(2, "0")}-${slugify(clip.clipTitle, `clip-${index + 1}`)}`;
    const videoPath = join(clipsDir, `${baseName}.mp4`);
    const coverPath = join(coversDir, `${baseName}.jpg`);
    const subtitlePath = join(clipsDir, `${baseName}.vtt`);
    const metadataPath = join(clipsDir, `${baseName}.json`);

    console.log(`[slice] Rendering ${basename(videoPath)} (${Math.round(clip.durationMs / 1000)}s)`);
    await sliceVideoFile(inputPath, videoPath, clip.startMs, clip.endMs);
    await extractVideoCover(videoPath, coverPath, Math.max(300, Math.round(clip.durationMs * 0.33)));
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
      coverPath,
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

async function publishIfEnabled(
  manifest: SliceManifest,
  options: {
    app?: string;
    publish?: boolean;
    publishedSlug?: string;
  },
) {
  if (options.publish === false) {
    return null;
  }

  const appDir = options.app ? resolve(options.app) : await detectAppDirectory();
  if (!appDir) {
    console.log("[publish] No app directory detected. Skipping auto-publish.");
    return null;
  }

  const published = await publishManifestToApp(manifest, appDir, options.publishedSlug);
  console.log(
    `[publish] Synced ${published.clipCount} clips to ${published.appDir} (${published.publicManifestPath})`,
  );
  return published;
}

async function loadManifestFromPath(manifestPath: string) {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as SliceManifest;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.clips) || typeof raw.animeTitle !== "string") {
    throw new Error(`Invalid slicer manifest: ${manifestPath}`);
  }
  return raw;
}

async function runSliceCommand(options: SliceCommandOptions) {
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
  await publishIfEnabled(manifest, options);
}

async function buildIngestCommandOptions(options: IngestCommandOptions) {
  const inputPath = resolve(options.input);
  await ensureFileExists(inputPath);

  const defaultMetadataPath = join(dirname(inputPath), `${basenameWithoutExtension(inputPath)}.json`);
  const metadataPath = options.metadata
    ? resolve(options.metadata)
    : (await pathExists(defaultMetadataPath))
      ? defaultMetadataPath
      : undefined;
  const metadata = await readAutoMetadata(metadataPath);
  const subtitlePath = pickString(options.subtitle, await findSidecarSubtitle(inputPath));
  const animeTitle =
    pickString(options.anime, metadata.animeTitle) ?? humanizeStem(basenameWithoutExtension(inputPath));
  const episodeTitle = pickString(options.episode, metadata.episodeTitle);
  const publishedSlug =
    pickString(options.publishedSlug, metadata.publishedSlug) ??
    slugify(`${animeTitle}-${episodeTitle ?? basenameWithoutExtension(inputPath)}`, basenameWithoutExtension(inputPath));

  return {
    input: inputPath,
    anime: animeTitle,
    episode: episodeTitle,
    subtitle: subtitlePath,
    output:
      options.output ??
      join(process.cwd(), "output", publishedSlug),
    minClips: String(
      parseIntegerOption(
        pickString(options.minClips, metadata.minClips?.toString()) ?? "5",
        "min-clips",
      ),
    ),
    maxClips: String(
      parseIntegerOption(
        pickString(options.maxClips, metadata.maxClips?.toString()) ?? "15",
        "max-clips",
      ),
    ),
    minDuration: String(
      parseIntegerOption(
        pickString(options.minDuration, metadata.minDurationSec?.toString()) ?? "10",
        "min-duration",
      ),
    ),
    maxDuration: String(
      parseIntegerOption(
        pickString(options.maxDuration, metadata.maxDurationSec?.toString()) ?? "60",
        "max-duration",
      ),
    ),
    app: options.app,
    publish: options.publish,
    publishedSlug,
  } satisfies SliceCommandOptions;
}

async function runIngestCommand(options: IngestCommandOptions) {
  const resolved = await buildIngestCommandOptions(options);
  await runSliceCommand(resolved);
}

async function loadWatchState(statePath: string) {
  if (!(await pathExists(statePath))) {
    return {
      processed: {},
    } satisfies WatchState;
  }

  try {
    const raw = JSON.parse(await readFile(statePath, "utf8")) as WatchState;
    if (!raw || typeof raw !== "object" || typeof raw.processed !== "object") {
      return {
        processed: {},
      } satisfies WatchState;
    }
    return raw;
  } catch {
    return {
      processed: {},
    } satisfies WatchState;
  }
}

async function saveWatchState(statePath: string, state: WatchState) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function fingerprintFile(pathValue: string) {
  const details = await stat(pathValue);
  return `${details.size}:${Math.round(details.mtimeMs)}`;
}

async function findSiblingVideo(filePath: string) {
  const extension = extname(filePath);
  const stemPath = filePath.slice(0, extension ? -extension.length : undefined);

  for (const candidateExtension of VIDEO_EXTENSIONS) {
    const candidate = `${stemPath}${candidateExtension}`;
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function runWatchInboxCommand(options: WatchInboxCommandOptions) {
  const inboxDir = resolve(options.inbox ?? join(process.cwd(), "inbox"));
  const outputRoot = resolve(options.outputRoot ?? join(process.cwd(), "output", "watched"));
  const statePath = join(inboxDir, ".watch-state.json");

  await Promise.all([ensureDirectory(inboxDir), ensureDirectory(outputRoot)]);

  const state = await loadWatchState(statePath);
  let queue = Promise.resolve();
  const active = new Set<string>();

  const processVideo = async (videoPath: string) => {
    const absoluteVideoPath = resolve(videoPath);
    if (!isVideoFile(absoluteVideoPath)) {
      return;
    }

    if (!(await pathExists(absoluteVideoPath))) {
      return;
    }

    const fingerprint = await fingerprintFile(absoluteVideoPath);
    if (state.processed[absoluteVideoPath] === fingerprint) {
      return;
    }

    const stem = basenameWithoutExtension(absoluteVideoPath);
    console.log(`[watch] Processing ${basename(absoluteVideoPath)}`);
    await runIngestCommand({
      input: absoluteVideoPath,
      output: join(outputRoot, slugify(stem, "episode")),
      minClips: options.minClips,
      maxClips: options.maxClips,
      minDuration: options.minDuration,
      maxDuration: options.maxDuration,
      app: options.app,
      publish: true,
    });
    state.processed[absoluteVideoPath] = fingerprint;
    await saveWatchState(statePath, state);
    console.log(`[watch] Finished ${basename(absoluteVideoPath)}`);
  };

  const enqueueVideo = (videoPath: string) => {
    const absoluteVideoPath = resolve(videoPath);
    if (active.has(absoluteVideoPath)) {
      return;
    }

    active.add(absoluteVideoPath);
    queue = queue
      .then(() => processVideo(absoluteVideoPath))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
      })
      .finally(() => {
        active.delete(absoluteVideoPath);
      });
  };

  const watcher = chokidar.watch(inboxDir, {
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 1200,
      pollInterval: 200,
    },
  });

  console.log(`[watch] Watching inbox: ${inboxDir}`);

  watcher.on("add", (pathValue) => {
    if (isVideoFile(pathValue)) {
      enqueueVideo(pathValue);
      return;
    }

    if (isSubtitleFile(pathValue) || extname(pathValue).toLowerCase() === ".json") {
      void findSiblingVideo(pathValue).then((videoPath) => {
        if (videoPath) {
          enqueueVideo(videoPath);
        }
      });
    }
  });

  watcher.on("change", (pathValue) => {
    if (isVideoFile(pathValue)) {
      delete state.processed[resolve(pathValue)];
      enqueueVideo(pathValue);
      return;
    }

    if (isSubtitleFile(pathValue) || extname(pathValue).toLowerCase() === ".json") {
      void findSiblingVideo(pathValue).then((videoPath) => {
        if (videoPath) {
          delete state.processed[resolve(videoPath)];
          enqueueVideo(videoPath);
        }
      });
    }
  });
}

async function runSyncAppCommand(options: {
  manifest: string;
  app?: string;
  slug?: string;
  watch?: boolean;
}) {
  const manifestPath = resolve(options.manifest);
  await ensureFileExists(manifestPath);

  const syncOnce = async () => {
    const manifest = await loadManifestFromPath(manifestPath);
    await publishIfEnabled(manifest, {
      app: options.app,
      publish: true,
      publishedSlug: options.slug,
    });
  };

  await syncOnce();

  if (!options.watch) {
    return;
  }

  console.log(`[watch] Watching ${manifestPath} for changes...`);
  const watcher = chokidar.watch(manifestPath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on("change", () => {
    void syncOnce().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
    });
  });
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
  .option("--app <dir>", "Auto-publish clips into a YuruNihongo app repo after slicing.")
  .option("--published-slug <slug>", "Optional folder slug when auto-publishing to the app.")
  .option("--no-publish", "Do not auto-publish into the detected YuruNihongo app repo.")
  .action(async (options) => {
    try {
      await runSliceCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

program
  .command("ingest")
  .requiredOption("--input <path>", "Path to a local anime video file.")
  .option("--anime <title>", "Anime title. Defaults to sidecar metadata or the filename.")
  .option("--episode <title>", "Episode label.")
  .option("--subtitle <path>", "Optional subtitle path. Defaults to a same-name sidecar subtitle if found.")
  .option("--metadata <path>", "Optional sidecar JSON with animeTitle/episodeTitle and slicing settings.")
  .option("--output <dir>", "Output directory. Defaults to ./output/<derived-slug>.")
  .option("--min-clips <count>", "Minimum number of clips.")
  .option("--max-clips <count>", "Maximum number of clips.")
  .option("--min-duration <seconds>", "Minimum duration per clip in seconds.")
  .option("--max-duration <seconds>", "Maximum duration per clip in seconds.")
  .option("--app <dir>", "Target YuruNihongo app directory.")
  .option("--published-slug <slug>", "Optional publish folder slug.")
  .option("--no-publish", "Do not auto-publish into the detected YuruNihongo app repo.")
  .action(async (options) => {
    try {
      await runIngestCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

program
  .command("watch-inbox")
  .option("--inbox <dir>", "Folder to watch for new video files. Defaults to ./inbox.")
  .option("--output-root <dir>", "Base output folder for watched renders. Defaults to ./output/watched.")
  .option("--app <dir>", "Target YuruNihongo app directory.")
  .option("--min-clips <count>", "Minimum number of clips to generate per video.")
  .option("--max-clips <count>", "Maximum number of clips to generate per video.")
  .option("--min-duration <seconds>", "Minimum duration per clip in seconds.")
  .option("--max-duration <seconds>", "Maximum duration per clip in seconds.")
  .action(async (options) => {
    try {
      await runWatchInboxCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

program
  .command("sync-app")
  .requiredOption("--manifest <path>", "Path to a generated manifest.json from anime-learning-slicer.")
  .option("--app <dir>", "Target YuruNihongo app directory.")
  .option("--slug <slug>", "Optional publish folder slug.")
  .option("--watch", "Watch the manifest and re-publish when it changes.", false)
  .action(async (options) => {
    try {
      await runSyncAppCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
