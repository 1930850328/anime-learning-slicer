export type DifficultyLevel = "N5" | "N4" | "Mixed" | "Custom";

export type SubtitleSource = "external" | "auto";

export interface RawSubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface AnnotatedToken {
  surface: string;
  base: string;
  reading: string;
  kana: string;
  romaji: string;
  partOfSpeech: string;
  meaningZh: string;
}

export interface KnowledgePoint {
  id: string;
  kind: "word" | "grammar" | "phrase";
  expression: string;
  reading: string;
  meaningZh: string;
  partOfSpeech: string;
  explanationZh: string;
  exampleJa: string;
  exampleZh: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  ja: string;
  kana: string;
  romaji: string;
  zh: string;
  focusTermIds: string[];
}

export interface GrammarPattern {
  id: string;
  pattern: string;
  label: string;
  meaningZh: string;
  explanationZh: string;
  level: DifficultyLevel;
}

export interface GrammarMatch extends GrammarPattern {
  matchedText: string;
}

export interface SentenceAnalysis {
  input: string;
  tokens: AnnotatedToken[];
  kana: string;
  romaji: string;
  glossZh: string;
  grammarMatches: GrammarMatch[];
}

export interface SliceCandidate {
  startIndex: number;
  endIndex: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  score: number;
  segments: TranscriptSegment[];
  knowledgePoints: KnowledgePoint[];
}

export interface SliceOptions {
  animeTitle: string;
  episodeTitle?: string;
  minClips: number;
  maxClips: number;
  minDurationSec: number;
  maxDurationSec: number;
  outputDir: string;
  inputPath: string;
}

export interface ClipOutput {
  id: string;
  animeTitle: string;
  episodeTitle?: string;
  clipTitle: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  videoPath: string;
  coverPath: string;
  subtitlePath: string;
  metadataPath: string;
  transcriptJa: string;
  transcriptZh: string;
  subtitleSource: SubtitleSource;
  exampleJa: string;
  exampleZh: string;
  keyNotes: string[];
  keywords: string[];
  knowledgePoints: KnowledgePoint[];
  segments: TranscriptSegment[];
}

export interface PreparedClip {
  id: string;
  clipTitle: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  transcriptJa: string;
  transcriptZh: string;
  exampleJa: string;
  exampleZh: string;
  keyNotes: string[];
  keywords: string[];
  knowledgePoints: KnowledgePoint[];
  segments: TranscriptSegment[];
}

export interface SliceManifest {
  animeTitle: string;
  episodeTitle?: string;
  sourceVideo: string;
  subtitleSource: SubtitleSource;
  generatedAt: string;
  clipCount: number;
  clips: ClipOutput[];
}

export interface SubtitleBuildResult {
  source: SubtitleSource;
  modelLabel?: string;
  cues: RawSubtitleCue[];
}
