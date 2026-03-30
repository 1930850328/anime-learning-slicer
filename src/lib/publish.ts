import { access, copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, resolve } from "node:path";

import { ensureDirectory, extractVideoCover } from "./ffmpeg.js";
import type { ClipOutput, SliceManifest } from "../types.js";

interface PublishedIndexEntry {
  slug: string;
  animeTitle: string;
  episodeTitle?: string;
  manifestPath: string;
  generatedAt: string;
  clipCount: number;
}

function slugify(input: string, fallback: string) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || fallback;
}

async function pathExists(pathValue: string) {
  try {
    await access(pathValue, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isYuruNihongoApp(appDir: string) {
  try {
    const packageJsonPath = resolve(appDir, "package.json");
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: string };
    return parsed.name === "happy-japannese";
  } catch {
    return false;
  }
}

export async function detectAppDirectory(fromDir = process.cwd()) {
  const envPath = process.env.YURU_APP_DIR?.trim();
  const candidates = [
    envPath,
    resolve(fromDir, "..", "Happy-Japannese"),
    resolve(fromDir, "..", "Happy-Japanese"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await isYuruNihongoApp(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function readPublishedIndex(indexPath: string) {
  if (!(await pathExists(indexPath))) {
    return [] as PublishedIndexEntry[];
  }

  try {
    const raw = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
    return Array.isArray(raw)
      ? raw.filter((item): item is PublishedIndexEntry => {
          return Boolean(
            item &&
              typeof item === "object" &&
              typeof (item as PublishedIndexEntry).slug === "string" &&
              typeof (item as PublishedIndexEntry).manifestPath === "string",
          );
        })
      : [];
  } catch {
    return [];
  }
}

function toPublicPath(...parts: string[]) {
  return `/${parts.join("/").replace(/\\/g, "/")}`;
}

function clipFileStem(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

async function safeResetDirectory(targetDir: string, allowedRoot: string) {
  const resolvedTarget = resolve(targetDir);
  const resolvedRoot = resolve(allowedRoot);

  if (!resolvedTarget.startsWith(resolvedRoot)) {
    throw new Error(`Refusing to remove a directory outside ${resolvedRoot}.`);
  }

  await rm(resolvedTarget, { recursive: true, force: true });
}

async function copyIfPresent(sourcePath: string, targetPath: string) {
  if (!(await pathExists(sourcePath))) {
    return false;
  }

  await copyFile(sourcePath, targetPath);
  return true;
}

export async function publishManifestToApp(
  manifest: SliceManifest,
  appDir: string,
  preferredSlug?: string,
) {
  const appPath = resolve(appDir);
  if (!(await isYuruNihongoApp(appPath))) {
    throw new Error(`Target app directory is not a YuruNihongo repo: ${appPath}`);
  }

  const generatedRoot = resolve(appPath, "public", "generated-slices");
  const slug =
    preferredSlug ??
    slugify(
      `${manifest.animeTitle}-${manifest.episodeTitle ?? ""}`.trim(),
      `generated-${manifest.clips.length}`,
    );
  const targetRoot = resolve(generatedRoot, slug);
  const clipsDir = resolve(targetRoot, "clips");
  const coversDir = resolve(targetRoot, "covers");

  await safeResetDirectory(targetRoot, generatedRoot);
  await stat(resolve(appPath, "public"));
  await Promise.all([ensureDirectory(clipsDir), ensureDirectory(coversDir)]);

  const publishedClips: ClipOutput[] = [];

  for (const clip of manifest.clips) {
    const videoName = basename(clip.videoPath);
    const subtitleName = basename(clip.subtitlePath);
    const metadataName = basename(clip.metadataPath);
    const coverName = `${clipFileStem(videoName)}.jpg`;

    const targetVideoPath = resolve(clipsDir, videoName);
    const targetSubtitlePath = resolve(clipsDir, subtitleName);
    const targetMetadataPath = resolve(clipsDir, metadataName);
    const targetCoverPath = resolve(coversDir, coverName);

    await copyFile(clip.videoPath, targetVideoPath);
    await copyIfPresent(clip.subtitlePath, targetSubtitlePath);
    await copyIfPresent(clip.metadataPath, targetMetadataPath);

    const coverProbeMs = Math.max(300, Math.min(clip.durationMs - 300, Math.round(clip.durationMs * 0.33)));
    await extractVideoCover(targetVideoPath, targetCoverPath, coverProbeMs);

    publishedClips.push({
      ...clip,
      videoPath: toPublicPath("generated-slices", slug, "clips", videoName),
      subtitlePath: toPublicPath("generated-slices", slug, "clips", subtitleName),
      metadataPath: toPublicPath("generated-slices", slug, "clips", metadataName),
      coverPath: toPublicPath("generated-slices", slug, "covers", coverName),
    });
  }

  const publishedManifest: SliceManifest = {
    ...manifest,
    clips: publishedClips,
  };

  const manifestPath = resolve(targetRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(publishedManifest, null, 2)}\n`, "utf8");

  const indexPath = resolve(generatedRoot, "index.json");
  const currentIndex = await readPublishedIndex(indexPath);
  const nextEntry: PublishedIndexEntry = {
    slug,
    animeTitle: manifest.animeTitle,
    episodeTitle: manifest.episodeTitle,
    manifestPath: toPublicPath("generated-slices", slug, "manifest.json"),
    generatedAt: manifest.generatedAt,
    clipCount: manifest.clipCount,
  };
  const nextIndex = [
    nextEntry,
    ...currentIndex.filter((entry) => entry.slug !== slug),
  ].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));

  await writeFile(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`, "utf8");

  return {
    appDir: appPath,
    slug,
    manifestPath,
    publicManifestPath: nextEntry.manifestPath,
    clipCount: publishedClips.length,
  };
}
