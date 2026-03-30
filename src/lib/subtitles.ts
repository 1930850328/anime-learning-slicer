import { readFile, writeFile } from "node:fs/promises";

import type { RawSubtitleCue, TranscriptSegment } from "../types.js";

function parseTimestamp(value: string) {
  const cleaned = value.trim().replace(",", ".");
  const parts = cleaned.split(":");
  if (parts.length < 3) {
    return 0;
  }

  const hours = Number(parts[0]) || 0;
  const minutes = Number(parts[1]) || 0;
  const seconds = Number(parts[2]) || 0;
  return Math.max(0, Math.round((hours * 3600 + minutes * 60 + seconds) * 1000));
}

function formatTimestamp(ms: number) {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function normalizeCueText(input: string) {
  return input
    .replace(/\{\\[^}]+\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function hasJapaneseText(input: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(input);
}

function parseTimedBlocks(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const cues: RawSubtitleCue[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.includes("-->")) {
      continue;
    }

    const [startText, endWithSettings] = line.split("-->");
    const endText = endWithSettings.trim().split(/\s+/)[0];
    const contentLines: string[] = [];

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) {
        index = cursor;
        break;
      }

      contentLines.push(lines[cursor]);
      if (cursor === lines.length - 1) {
        index = cursor;
      }
    }

    const cueText = normalizeCueText(contentLines.join("\n"));
    if (!cueText || !hasJapaneseText(cueText)) {
      continue;
    }

    cues.push({
      startMs: parseTimestamp(startText),
      endMs: parseTimestamp(endText),
      text: cueText,
    });
  }

  return cues;
}

function parseAss(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const cues: RawSubtitleCue[] = [];

  for (const line of lines) {
    if (!line.startsWith("Dialogue:")) {
      continue;
    }

    const payload = line.slice("Dialogue:".length).trim();
    const fields: string[] = [];
    let current = "";
    let commaCount = 0;

    for (const character of payload) {
      if (character === "," && commaCount < 9) {
        fields.push(current);
        current = "";
        commaCount += 1;
        continue;
      }

      current += character;
    }

    fields.push(current);
    if (fields.length < 10) {
      continue;
    }

    const cueText = normalizeCueText(fields[9]);
    if (!cueText || !hasJapaneseText(cueText)) {
      continue;
    }

    cues.push({
      startMs: parseTimestamp(fields[1]),
      endMs: parseTimestamp(fields[2]),
      text: cueText,
    });
  }

  return cues;
}

export async function parseSubtitleFile(subtitlePath: string) {
  const text = await readFile(subtitlePath, "utf8");
  const lower = subtitlePath.toLowerCase();

  if (lower.endsWith(".ass")) {
    return parseAss(text);
  }

  return parseTimedBlocks(text);
}

export function toClipRelativeSegments(segments: TranscriptSegment[], clipStartMs: number, clipEndMs: number) {
  return segments
    .filter((segment) => segment.endMs > clipStartMs && segment.startMs < clipEndMs)
    .map((segment) => ({
      ...segment,
      startMs: Math.max(0, segment.startMs - clipStartMs),
      endMs: Math.min(clipEndMs - clipStartMs, segment.endMs - clipStartMs),
    }))
    .filter((segment) => segment.endMs > segment.startMs);
}

export function buildBilingualVtt(segments: TranscriptSegment[]) {
  const blocks = segments.map((segment, index) => {
    const start = formatTimestamp(segment.startMs);
    const end = formatTimestamp(segment.endMs);
    const lines = [segment.ja, segment.zh].filter(Boolean).join("\n");
    return `${index + 1}\n${start} --> ${end}\n${lines}`;
  });

  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

export async function writeVttFile(outputPath: string, segments: TranscriptSegment[]) {
  await writeFile(outputPath, buildBilingualVtt(segments), "utf8");
}
