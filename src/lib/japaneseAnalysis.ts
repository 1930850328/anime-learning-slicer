import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import kuromoji, { type IpadicFeatures, type Tokenizer } from "kuromoji";
import * as wanakana from "wanakana";

import { grammarPatterns } from "../data/grammarPatterns.js";
import { seedLexicon } from "../data/seedLexicon.js";
import type {
  AnnotatedToken,
  GrammarMatch,
  KnowledgePoint,
  RawSubtitleCue,
  SentenceAnalysis,
  TranscriptSegment,
} from "../types.js";

const require = createRequire(import.meta.url);
const kuromojiPackagePath = require.resolve("kuromoji/package.json");
const dictPath = join(dirname(kuromojiPackagePath), "dict");

let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null;

function buildTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: dictPath }).build((error, tokenizer) => {
        if (error || !tokenizer) {
          reject(error ?? new Error("Could not initialize kuromoji tokenizer."));
          return;
        }

        resolve(tokenizer);
      });
    });
  }

  return tokenizerPromise;
}

function normalizePartOfSpeech(token: IpadicFeatures) {
  return [token.pos, token.pos_detail_1].filter((value) => value && value !== "*").join(" / ") || "未分类";
}

function lookupMeaning(surface: string, base: string, reading: string, kana: string) {
  return (
    seedLexicon.get(surface) ??
    seedLexicon.get(base) ??
    seedLexicon.get(reading) ??
    seedLexicon.get(kana) ??
    "可结合上下文记忆这个表达。"
  );
}

function createAnnotatedToken(token: IpadicFeatures): AnnotatedToken {
  const surface = token.surface_form;
  const base = token.basic_form && token.basic_form !== "*" ? token.basic_form : surface;
  const reading = token.reading && token.reading !== "*" ? token.reading : surface;
  const kana = wanakana.toHiragana(reading);

  return {
    surface,
    base,
    reading,
    kana,
    romaji: wanakana.toRomaji(kana || surface),
    partOfSpeech: normalizePartOfSpeech(token),
    meaningZh: lookupMeaning(surface, base, reading, kana),
  };
}

function createFallbackTokens(input: string) {
  const chunks = input.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+|[A-Za-z]+|\d+|[^\s]/gu) ?? [input];
  return chunks
    .filter((chunk) => chunk.trim())
    .map<AnnotatedToken>((chunk) => {
      const kana = wanakana.toHiragana(chunk);
      return {
        surface: chunk,
        base: chunk,
        reading: chunk,
        kana,
        romaji: wanakana.toRomaji(kana || chunk),
        partOfSpeech: "未分类",
        meaningZh: lookupMeaning(chunk, chunk, chunk, kana),
      };
    });
}

function matchGrammar(input: string): GrammarMatch[] {
  return grammarPatterns
    .filter((pattern) => input.includes(pattern.pattern))
    .map((pattern) => ({
      ...pattern,
      matchedText: pattern.pattern,
    }));
}

function buildSentenceKana(tokens: AnnotatedToken[], input: string) {
  const joined = tokens.map((token) => token.kana || token.surface).join("");
  return joined || wanakana.toHiragana(input);
}

function buildSentenceRomaji(tokens: AnnotatedToken[], kana: string) {
  const joined = tokens.map((token) => token.romaji).filter(Boolean).join(" ");
  return joined || wanakana.toRomaji(kana);
}

function buildGloss(tokens: AnnotatedToken[], grammarMatches: GrammarMatch[]) {
  const leadWords = tokens
    .filter((token) => !token.partOfSpeech.includes("助詞") && !token.partOfSpeech.includes("記号"))
    .slice(0, 4)
    .map((token) => `${token.surface}(${token.meaningZh})`);

  const grammarPart =
    grammarMatches.length > 0
      ? `语法重点：${grammarMatches.map((match) => `${match.pattern}=${match.meaningZh}`).join(" / ")}。`
      : "语法重点：可先关注句尾语气和高频动词。";

  const wordPart =
    leadWords.length > 0 ? `关键词：${leadWords.join(" / ")}。` : "关键词：请结合上下文理解这句台词。";

  return `${wordPart}${grammarPart}`;
}

function isUsefulToken(token: AnnotatedToken) {
  if (!token.surface.trim()) {
    return false;
  }

  if (token.surface.length < 2) {
    return false;
  }

  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token.surface)) {
    return false;
  }

  return !token.partOfSpeech.includes("助詞") && !token.partOfSpeech.includes("記号");
}

export async function analyzeJapaneseText(input: string): Promise<SentenceAnalysis> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      input: "",
      tokens: [],
      kana: "",
      romaji: "",
      glossZh: "",
      grammarMatches: [],
    };
  }

  let tokens: AnnotatedToken[];
  try {
    const tokenizer = await buildTokenizer();
    tokens = tokenizer.tokenize(trimmed).filter((token) => token.surface_form.trim()).map(createAnnotatedToken);
  } catch {
    tokens = createFallbackTokens(trimmed);
  }

  const grammarMatches = matchGrammar(trimmed);
  const kana = buildSentenceKana(tokens, trimmed);
  const romaji = buildSentenceRomaji(tokens, kana);

  return {
    input: trimmed,
    tokens,
    kana,
    romaji,
    glossZh: buildGloss(tokens, grammarMatches),
    grammarMatches,
  };
}

export async function buildStudyDataFromCues(cues: RawSubtitleCue[]) {
  const knowledgeMap = new Map<string, KnowledgePoint>();
  const segments: TranscriptSegment[] = [];

  for (const cue of cues) {
    const analysis = await analyzeJapaneseText(cue.text);
    const focusTermIds: string[] = [];

    for (const match of analysis.grammarMatches.slice(0, 2)) {
      const id = `grammar:${match.id}`;
      if (!knowledgeMap.has(id)) {
        knowledgeMap.set(id, {
          id,
          kind: "grammar",
          expression: match.pattern,
          reading: match.pattern,
          meaningZh: match.meaningZh,
          partOfSpeech: "语法",
          explanationZh: match.explanationZh,
          exampleJa: cue.text,
          exampleZh: analysis.glossZh,
        });
      }
      focusTermIds.push(id);
    }

    for (const token of analysis.tokens.filter(isUsefulToken).slice(0, 3)) {
      const baseKey = token.base || token.surface;
      const id = `word:${baseKey}`;
      if (!knowledgeMap.has(id)) {
        knowledgeMap.set(id, {
          id,
          kind: "word",
          expression: token.surface,
          reading: token.kana || token.reading,
          meaningZh: token.meaningZh,
          partOfSpeech: token.partOfSpeech,
          explanationZh: "这是片段中的高频或可暂停学习的核心表达，建议先跟读再回放确认语气。",
          exampleJa: cue.text,
          exampleZh: analysis.glossZh,
        });
      }
      focusTermIds.push(id);
    }

    segments.push({
      startMs: cue.startMs,
      endMs: cue.endMs,
      ja: cue.text,
      kana: analysis.kana,
      romaji: analysis.romaji,
      zh: analysis.glossZh,
      focusTermIds,
    });
  }

  return {
    segments,
    knowledgePoints: [...knowledgeMap.values()],
  };
}

export function buildKeyNotes(points: KnowledgePoint[]) {
  if (points.length === 0) {
    return ["This clip is best used for shadowing and listening rhythm."];
  }

  return points.slice(0, 4).map((point) => {
    if (point.kind === "grammar") {
      return `Grammar ${point.expression}: ${point.meaningZh}`;
    }

    return `Word ${point.expression}: ${point.meaningZh}`;
  });
}

export function buildKeywords(points: KnowledgePoint[]) {
  return [...new Set(points.slice(0, 6).map((point) => point.expression))];
}

export function buildExampleSentence(segments: TranscriptSegment[]) {
  const best = segments.find((segment) => segment.focusTermIds.length > 0) ?? segments[0];
  return {
    exampleJa: best?.ja ?? "",
    exampleZh: best?.zh ?? "",
  };
}

export function createKnowledgeDigest(points: KnowledgePoint[]) {
  const map = new Map<string, KnowledgePoint>();
  for (const point of points) {
    map.set(point.id, point);
  }
  return [...map.values()];
}

export function createClipId(index: number) {
  return `clip-${String(index + 1).padStart(2, "0")}-${randomUUID().slice(0, 8)}`;
}
