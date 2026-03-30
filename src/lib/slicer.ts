import {
  buildExampleSentence,
  buildKeyNotes,
  buildKeywords,
  buildStudyDataFromCues,
  createClipId,
  createKnowledgeDigest,
} from "./japaneseAnalysis.js";
import type {
  KnowledgePoint,
  PreparedClip,
  SliceCandidate,
  SliceOptions,
  SubtitleBuildResult,
  TranscriptSegment,
} from "../types.js";

const DEFAULT_MAX_SEGMENTS_PER_CLIP = 6;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function uniquePoints(points: KnowledgePoint[]) {
  return createKnowledgeDigest(points);
}

function collectPointsForWindow(
  knowledgeMap: Map<string, KnowledgePoint>,
  segments: TranscriptSegment[],
  startIndex: number,
  endIndex: number,
) {
  const pointIds = new Set(segments.slice(startIndex, endIndex + 1).flatMap((segment) => segment.focusTermIds));
  return [...pointIds]
    .map((id) => knowledgeMap.get(id))
    .filter((point): point is KnowledgePoint => Boolean(point));
}

function hasStudyValue(points: KnowledgePoint[]) {
  const grammarCount = points.filter((point) => point.kind === "grammar").length;
  const wordCount = points.filter((point) => point.kind === "word").length;
  return grammarCount >= 1 || wordCount >= 2;
}

function scoreWindow(durationMs: number, points: KnowledgePoint[], segments: TranscriptSegment[]) {
  const grammarCount = points.filter((point) => point.kind === "grammar").length;
  const wordCount = points.filter((point) => point.kind === "word").length;
  const phraseCount = points.filter((point) => point.kind === "phrase").length;
  const targetMs = clamp(durationMs, 10_000, 60_000);
  const closeness = 1 - Math.min(1, Math.abs(durationMs - targetMs) / Math.max(targetMs, 1));
  const subtitleDensity = segments.reduce((sum, segment) => sum + segment.ja.length, 0) / Math.max(segments.length, 1);
  return grammarCount * 6 + wordCount * 2.5 + phraseCount + closeness * 2 + Math.min(3, subtitleDensity / 12);
}

function overlapRatio(left: SliceCandidate, right: SliceCandidate) {
  const start = Math.max(left.startMs, right.startMs);
  const end = Math.min(left.endMs, right.endMs);
  const overlapMs = Math.max(0, end - start);
  const shorter = Math.min(left.durationMs, right.durationMs);
  return shorter <= 0 ? 0 : overlapMs / shorter;
}

function normalizeSegments(segments: TranscriptSegment[], offsetMs: number, maxDurationMs: number) {
  return segments
    .map((segment) => ({
      ...segment,
      startMs: Math.max(0, segment.startMs - offsetMs),
      endMs: Math.min(maxDurationMs, Math.max(0, segment.endMs - offsetMs)),
    }))
    .filter((segment) => segment.endMs > segment.startMs);
}

function buildFallbackCandidates(segments: TranscriptSegment[], minMs: number) {
  const fallback: SliceCandidate[] = [];
  let startIndex = 0;

  while (startIndex < segments.length) {
    let endIndex = startIndex;
    let endMs = segments[startIndex].endMs;

    while (endIndex + 1 < segments.length && endMs - segments[startIndex].startMs < minMs) {
      endIndex += 1;
      endMs = segments[endIndex].endMs;
    }

    const durationMs = endMs - segments[startIndex].startMs;
    fallback.push({
      startIndex,
      endIndex,
      startMs: segments[startIndex].startMs,
      endMs,
      durationMs,
      score: 0.5,
      segments: segments.slice(startIndex, endIndex + 1),
      knowledgePoints: [],
    });

    startIndex = endIndex + 1;
  }

  return fallback;
}

function buildCandidateWindows(
  segments: TranscriptSegment[],
  knowledgePoints: KnowledgePoint[],
  minMs: number,
  maxMs: number,
) {
  const knowledgeMap = new Map(knowledgePoints.map((point) => [point.id, point]));
  const candidates: SliceCandidate[] = [];

  for (let startIndex = 0; startIndex < segments.length; startIndex += 1) {
    for (
      let endIndex = startIndex;
      endIndex < Math.min(segments.length, startIndex + DEFAULT_MAX_SEGMENTS_PER_CLIP);
      endIndex += 1
    ) {
      const startMs = segments[startIndex].startMs;
      const endMs = segments[endIndex].endMs;
      const durationMs = endMs - startMs;
      if (durationMs < minMs || durationMs > maxMs) {
        continue;
      }

      const windowSegments = segments.slice(startIndex, endIndex + 1);
      const points = uniquePoints(collectPointsForWindow(knowledgeMap, segments, startIndex, endIndex));
      if (!hasStudyValue(points)) {
        continue;
      }

      candidates.push({
        startIndex,
        endIndex,
        startMs,
        endMs,
        durationMs,
        score: scoreWindow(durationMs, points, windowSegments),
        segments: windowSegments,
        knowledgePoints: points,
      });
    }
  }

  if (candidates.length > 0) {
    return candidates.sort((left, right) => right.score - left.score);
  }

  return buildFallbackCandidates(segments, minMs);
}

function selectCandidates(candidates: SliceCandidate[], minClips: number, maxClips: number) {
  const selected: SliceCandidate[] = [];

  for (const candidate of candidates) {
    if (selected.some((existing) => overlapRatio(existing, candidate) > 0.35)) {
      continue;
    }

    selected.push(candidate);
    if (selected.length >= maxClips) {
      break;
    }
  }

  if (selected.length < minClips) {
    for (const candidate of candidates) {
      if (selected.includes(candidate)) {
        continue;
      }

      if (selected.some((existing) => overlapRatio(existing, candidate) > 0.7)) {
        continue;
      }

      selected.push(candidate);
      if (selected.length >= minClips) {
        break;
      }
    }
  }

  return selected.sort((left, right) => left.startMs - right.startMs);
}

function ensureMinimumClips(
  selected: SliceCandidate[],
  fallbackCandidates: SliceCandidate[],
  minClips: number,
) {
  if (selected.length >= minClips) {
    return selected.sort((left, right) => left.startMs - right.startMs);
  }

  const next = [...selected];
  for (const candidate of fallbackCandidates) {
    if (next.some((existing) => overlapRatio(existing, candidate) > 0.8)) {
      continue;
    }

    next.push(candidate);
    if (next.length >= minClips) {
      break;
    }
  }

  return next.sort((left, right) => left.startMs - right.startMs);
}

function buildClipTitle(options: SliceOptions, index: number, points: KnowledgePoint[]) {
  const pointLabel = points.slice(0, 2).map((point) => point.expression).join(" / ");
  const episode = options.episodeTitle ? ` ${options.episodeTitle}` : "";
  return pointLabel
    ? `${options.animeTitle}${episode} Study Clip ${index + 1}: ${pointLabel}`
    : `${options.animeTitle}${episode} Study Clip ${index + 1}`;
}

function buildTranscriptJa(segments: TranscriptSegment[]) {
  return segments.map((segment) => segment.ja).join(" ");
}

function buildTranscriptZh(segments: TranscriptSegment[]) {
  return segments.map((segment) => segment.zh).join(" ");
}

export async function buildSlicePlan(options: SliceOptions, subtitleBuild: SubtitleBuildResult) {
  const { segments, knowledgePoints } = await buildStudyDataFromCues(subtitleBuild.cues);
  if (segments.length === 0) {
    throw new Error("No usable subtitle segments were found.");
  }

  const minMs = Math.max(10_000, Math.round(options.minDurationSec * 1000));
  const maxMs = Math.max(minMs, Math.round(options.maxDurationSec * 1000));
  const candidates = buildCandidateWindows(segments, knowledgePoints, minMs, maxMs);
  const fallbackCandidates = buildFallbackCandidates(segments, minMs);
  const preferredSelection = selectCandidates(candidates, options.minClips, options.maxClips);
  const fallbackSelection = selectCandidates(
    fallbackCandidates,
    options.minClips,
    options.maxClips,
  );
  const selected =
    preferredSelection.length >= options.minClips
      ? preferredSelection
      : ensureMinimumClips(fallbackSelection, fallbackCandidates, options.minClips);

  const clips: PreparedClip[] = selected.map((candidate, index) => {
    const clipKnowledge = uniquePoints(candidate.knowledgePoints);
    const clipSegments = normalizeSegments(candidate.segments, candidate.startMs, candidate.durationMs);
    const example = buildExampleSentence(candidate.segments);

    return {
      id: createClipId(index),
      clipTitle: buildClipTitle(options, index, clipKnowledge),
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      durationMs: candidate.durationMs,
      transcriptJa: buildTranscriptJa(candidate.segments),
      transcriptZh: buildTranscriptZh(candidate.segments),
      exampleJa: example.exampleJa,
      exampleZh: example.exampleZh,
      keyNotes: buildKeyNotes(clipKnowledge),
      keywords: buildKeywords(clipKnowledge),
      knowledgePoints: clipKnowledge,
      segments: clipSegments,
    };
  });

  return {
    subtitleSource: subtitleBuild.source,
    modelLabel: subtitleBuild.modelLabel,
    clips,
  };
}
