import "dotenv/config";
import process from "node:process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { URL } from "node:url";
import OpenAI from "openai";
import {
  Agent,
  run,
  setDefaultOpenAIClient,
  setOpenAIAPI,
} from "@openai/agents";

globalThis.__indexingInternals = {
  process,
  createHash,
  mkdir,
  readFile,
  writeFile,
  dirname,
  join,
  resolve,
  URL,
  BAGGAGE_FACETS: [
    { facet: "carry_on", pattern: /\b(carry[\s-]?on|cabin bag(?:gage)?|hand bag(?:gage)?|personal item)\b/iu },
    { facet: "first_checked_bag", pattern: /\b(first checked bag|1st bag|first bag|checked bag(?: allowance)?|checked baggage)\b/iu },
    { facet: "second_checked_bag", pattern: /\b(second checked bag|2nd bag|second bag)\b/iu },
    { facet: "oversize", pattern: /\b(oversize|oversized|size limit|dimension(?:s)? limit)\b/iu },
    { facet: "overweight", pattern: /\b(overweight|weight limit|weight allowance)\b/iu },
    { facet: "special_items", pattern: /\b(special item|sporting equipment|musical instrument)\b/iu },
    { facet: "additional_policy", pattern: /\b(additional policy|policy|allowance|fees?)\b/iu },
  ],
};

const __configModule = (() => {
function readNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return value;
}

function readString(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

const config = {
  port: readNumber("PORT", 3000),
  pythonBin: readString("PYTHON_BIN", "python"),
  openAiApiKey: readString("OPENAI_API_KEY"),
  openAiBaseUrl: readString("OPENAI_BASE_URL", "https://api.openai.com/v1"),
  openAiChatModel: readString("OPENAI_CHAT_MODEL", "gpt-4o-mini"),
  openAiEmbeddingModel: readString(
    "OPENAI_EMBEDDING_MODEL",
    "text-embedding-3-small",
  ),
  qdrantUrl: readString("QDRANT_URL", "http://localhost:6333"),
  qdrantApiKey: readString("QDRANT_API_KEY"),
  qdrantCollection: readString("QDRANT_COLLECTION", "url_kb"),
  crawl4aiBaseUrl: readString("CRAWL4AI_BASE_URL", "http://localhost:11235"),
  crawl4aiPollIntervalMs: readNumber("CRAWL4AI_POLL_INTERVAL_MS", 3000),
  crawl4aiTimeoutMs: readNumber("CRAWL4AI_TIMEOUT_MS", 120000),
  ingestConcurrency: readNumber("INGEST_CONCURRENCY", 3),
  defaultTopK: readNumber("DEFAULT_TOP_K", 6),
  chunking: {
    targetChars: readNumber("CHUNK_TARGET_CHARS", 4500),
    overlapChars: readNumber("CHUNK_OVERLAP_CHARS", 500),
  },
  paths: {
    rootDir: process.cwd(),
    dataDir: resolve(process.cwd(), "data"),
    crawl4aiDir: resolve(process.cwd(), "data", "crawl4ai"),
    rawDir: resolve(process.cwd(), "data", "raw"),
    chunksDir: resolve(process.cwd(), "data", "chunks"),
    tracesDir: resolve(process.cwd(), "data", "traces"),
  },
};

  return { config };
})();
const __asyncModule = (() => {
async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return results;
}

  return { sleep, mapWithConcurrency };
})();
const __hashModule = (() => {
const { createHash } = globalThis.__indexingInternals;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashToUuid(value) {
  const hash = sha256(value);

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

  return { sha256, hashToUuid };
})();
const __urlModule = (() => {
const { URL } = globalThis.__indexingInternals;
const { sha256 } = __hashModule;

function getDomain(url) {
  return new URL(url).hostname;
}

function fileStemForUrl(url) {
  const parsed = new URL(url);
  const base = `${parsed.hostname}${parsed.pathname}`
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();

  return `${base || "document"}-${sha256(url).slice(0, 12)}`;
}

  return { getDomain, fileStemForUrl };
})();
const __filesModule = (() => {
const { mkdir, readFile, writeFile, dirname } = globalThis.__indexingInternals;

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function readJson(path) {
  const content = await readFile(path, "utf8");
  return JSON.parse(content);
}

async function writeJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readLinesFile(path) {
  const content = await readFile(path, "utf8");

  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

  return { ensureDir, readJson, writeJson, readLinesFile };
})();
const __chunkerModule = (() => {
const { hashToUuid, sha256 } = __hashModule;
const { getDomain } = __urlModule;

function normalizeText(text) {
  return text.replace(/\r\n/gu, "\n").trim();
}

function splitMarkdownBlocks(markdown) {
  const lines = normalizeText(markdown).split("\n");
  const blocks = [];
  let buffer = [];

  function flushParagraph() {
    if (!buffer.length) {
      return;
    }

    const text = buffer.join("\n").trim();
    if (text) {
      blocks.push({ type: "paragraph", text });
    }

    buffer = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/u);

    if (headingMatch) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    buffer.push(line);
  }

  flushParagraph();
  return blocks;
}

function splitOversizedSegment(text, targetChars) {
  const normalized = normalizeText(text || "");
  if (!normalized) {
    return [];
  }

  if (!targetChars || normalized.length <= targetChars) {
    return [normalized];
  }

  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const segments = [];
    let current = [];
    let currentLength = 0;

    for (const line of lines) {
      const lineLength = line.length + (current.length ? 1 : 0);

      if (current.length && currentLength + lineLength > targetChars) {
        segments.push(current.join("\n"));
        current = [];
        currentLength = 0;
      }

      if (line.length > targetChars) {
        if (current.length) {
          segments.push(current.join("\n"));
          current = [];
          currentLength = 0;
        }

        for (let index = 0; index < line.length; index += targetChars) {
          segments.push(line.slice(index, index + targetChars));
        }
        continue;
      }

      current.push(line);
      currentLength += lineLength;
    }

    if (current.length) {
      segments.push(current.join("\n"));
    }

    return segments.filter(Boolean);
  }

  const segments = [];
  for (let index = 0; index < normalized.length; index += targetChars) {
    segments.push(normalized.slice(index, index + targetChars));
  }
  return segments;
}

function updateHeadingStack(stack, level, text) {
  const next = stack.slice(0, level - 1);
  next[level - 1] = text;
  return next;
}

function collectOverlapParagraphs(paragraphs, overlapChars) {
  if (!overlapChars || !paragraphs.length) {
    return [];
  }

  const overlap = [];
  let total = 0;

  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    overlap.unshift(paragraphs[index]);
    total += paragraphs[index].length;

    if (total >= overlapChars) {
      break;
    }
  }

  return overlap;
}

function buildChunkText(leadHeading, paragraphs) {
  return [leadHeading, ...paragraphs].filter(Boolean).join("\n\n").trim();
}

function extractTitleFromMarkdown(markdown) {
  const heading = normalizeText(markdown)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line);

  if (!heading) {
    return "Untitled";
  }

  return heading.replace(/^#{1,6}\s+/u, "").trim() || "Untitled";
}

function chunkDocument(rawDoc, options) {
  const text = normalizeText(rawDoc.cleanedText || "");

  if (!text) {
    return [];
  }

  const blocks = splitMarkdownBlocks(text);
  const chunks = [];
  let headingStack = [];
  let pendingHeading = null;
  let currentParagraphs = [];
  let currentLeadHeading = null;
  let currentSectionPath = [];

  function flushChunk({ carryOverlap }) {
    if (!currentParagraphs.length) {
      return;
    }

    const chunkText = buildChunkText(currentLeadHeading, currentParagraphs);
    chunks.push({
      id: hashToUuid(`${rawDoc.docId}:${chunks.length}`),
      docId: rawDoc.docId,
      url: rawDoc.url,
      domain: getDomain(rawDoc.url),
      title: rawDoc.title || extractTitleFromMarkdown(rawDoc.cleanedText),
      chunkIndex: chunks.length,
      sectionPath: [...currentSectionPath],
      fetchedAt: rawDoc.fetchedAt,
      contentHash: rawDoc.contentHash,
      text: chunkText,
      textHash: sha256(chunkText),
    });

    if (carryOverlap) {
      currentParagraphs = collectOverlapParagraphs(
        currentParagraphs,
        options.overlapChars,
      );
    } else {
      currentParagraphs = [];
    }

    if (!currentParagraphs.length) {
      currentLeadHeading = null;
      currentSectionPath = [];
    }
  }

  for (const block of blocks) {
    if (block.type === "heading") {
      if (currentParagraphs.length) {
        flushChunk({ carryOverlap: false });
      }

      headingStack = updateHeadingStack(headingStack, block.level, block.text);
      pendingHeading = `${"#".repeat(block.level)} ${block.text}`;
      continue;
    }

    const segments = splitOversizedSegment(block.text, options.targetChars);

    for (const segment of segments) {
      if (!currentParagraphs.length) {
        currentSectionPath = [...headingStack];
        currentLeadHeading = pendingHeading;
        pendingHeading = null;
      }

      const nextParagraphs = [...currentParagraphs, segment];
      const prospectiveText = buildChunkText(currentLeadHeading, nextParagraphs);

      if (
        currentParagraphs.length > 0 &&
        prospectiveText.length > options.targetChars
      ) {
        flushChunk({ carryOverlap: true });

        if (!currentParagraphs.length) {
          currentSectionPath = [...headingStack];
          currentLeadHeading =
            pendingHeading ||
            currentLeadHeading ||
            (headingStack.length ? `## ${headingStack.at(-1)}` : null);
        }
      }

      if (!currentParagraphs.length) {
        currentSectionPath = [...headingStack];
        currentLeadHeading =
          pendingHeading ||
          currentLeadHeading ||
          (headingStack.length ? `## ${headingStack.at(-1)}` : null);
        pendingHeading = null;
      }

      currentParagraphs.push(segment);
    }
  }

  flushChunk({ carryOverlap: false });
  return chunks;
}

  return { extractTitleFromMarkdown, chunkDocument };
})();
const __ingestionTraceModule = (() => {
const { join } = globalThis.__indexingInternals;
const { hashToUuid } = __hashModule;
const { fileStemForUrl } = __urlModule;
const { writeJson } = __filesModule;

function nowIso() {
  return new Date().toISOString();
}

function summarizeApiKey(value) {
  return value ? `configured (${value.length} chars)` : "missing";
}

function summarizeSectionPaths(chunks) {
  const unique = new Set();

  for (const chunk of chunks) {
    const sectionPath = chunk.sectionPath?.length
      ? chunk.sectionPath.join(" > ")
      : "General";

    unique.add(sectionPath);

    if (unique.size >= 10) {
      break;
    }
  }

  return [...unique];
}

class IngestionTrace {
  constructor({ config, url }) {
    this.tracePath = join(
      config.paths.tracesDir,
      `${fileStemForUrl(url)}.trace.json`,
    );
    this.state = {
      traceId: hashToUuid(`trace:${url}:${Date.now()}`),
      url,
      status: "running",
      startedAt: nowIso(),
      updatedAt: nowIso(),
      finishedAt: null,
      requirements: {
        services: {
          crawl4ai: {
            baseUrl: config.crawl4aiBaseUrl,
            requiredEndpoints: [
              "POST /crawl/job",
              "GET /crawl/job/{task_id}",
            ],
          },
          qdrant: {
            url: config.qdrantUrl,
            collection: config.qdrantCollection,
          },
          openai: {
            baseUrl: config.openAiBaseUrl,
            embeddingModel: config.openAiEmbeddingModel,
            chatModel: config.openAiChatModel,
            apiKey: summarizeApiKey(config.openAiApiKey),
          },
        },
        environment: {
          OPENAI_API_KEY: Boolean(config.openAiApiKey),
          QDRANT_URL: Boolean(config.qdrantUrl),
          CRAWL4AI_BASE_URL: Boolean(config.crawl4aiBaseUrl),
        },
      },
      pipeline: {
        qdrantCollection: config.qdrantCollection,
        ingestConcurrency: config.ingestConcurrency,
        crawl4aiPollIntervalMs: config.crawl4aiPollIntervalMs,
        crawl4aiTimeoutMs: config.crawl4aiTimeoutMs,
        chunkTargetChars: config.chunking.targetChars,
        chunkOverlapChars: config.chunking.overlapChars,
      },
      steps: [],
      summary: null,
      error: null,
    };
  }

  async persist() {
    this.state.updatedAt = nowIso();
    await writeJson(this.tracePath, this.state);
  }

  async recordStep({ stage, status = "info", message, data = null }) {
    this.state.steps.push({
      index: this.state.steps.length,
      at: nowIso(),
      stage,
      status,
      message,
      data,
    });
    await this.persist();
  }

  async complete(summary) {
    this.state.status = summary?.status || "completed";
    this.state.summary = summary;
    this.state.finishedAt = nowIso();
    await this.persist();
  }

  async fail(error, extra = null) {
    this.state.status = "failed";
    this.state.error = {
      message: error.message,
      ...(extra ? { details: extra } : {}),
    };
    this.state.finishedAt = nowIso();
    await this.recordStep({
      stage: "pipeline_failed",
      status: "error",
      message: error.message,
      data: extra,
    });
  }
}

function buildChunkingSummary(chunks) {
  const lengths = chunks.map((chunk) => chunk.text.length);
  const totalLength = lengths.reduce((sum, value) => sum + value, 0);

  return {
    chunkCount: chunks.length,
    minChunkLength: Math.min(...lengths),
    maxChunkLength: Math.max(...lengths),
    averageChunkLength: Math.round(totalLength / chunks.length),
    sampleSectionPaths: summarizeSectionPaths(chunks),
  };
}

function createIngestionTrace({ config, url }) {
  return new IngestionTrace({ config, url });
}

  return { IngestionTrace, buildChunkingSummary, createIngestionTrace };
})();
const __hybridDocumentsModule = (() => {
const { hashToUuid, sha256 } = __hashModule;
const { getDomain } = __urlModule;
const { BAGGAGE_FACETS } = globalThis.__indexingInternals;

const UNUSABLE_TITLE_PATTERN =
  /\b(pardon our interruption|just a moment|forbidden|not found|access denied)\b/iu;
const UNUSABLE_TEXT_PATTERN =
  /\b(you were a bot|made us think you were a bot|forbidden|captcha|access denied)\b/iu;
const DIRECTORY_LABEL_PATTERN =
  /^(airlines|destinations|carryon|carry-on|1st bag|2nd bag|additional policy)$/iu;
const VALUE_LABEL_PATTERN =
  /^(destinations?|carryon|carry-on|1st bag|2nd bag|additional policy)\s*:/iu;
const NAVIGATION_LINE_PATTERN =
  /^(skip to|book now|call us|language|help & contact|searching top deals|loading)$/iu;
const PRIVACY_SUBHEADING_PATTERN = /^\*\*([^*]{3,120})\*\*$/u;
const PRIVACY_FOOTER_MARKER_PATTERN =
  /(i'?m done|earn 2x points on cheapoair app|sign up today and never miss another deal again|easy access|connect with us|react-lp-infopages)/iu;
const AIRLINE_CONTENT_HEADING_PATTERN =
  /^(#{1,6})\s+.*\b(allowance|carry[- ]on|checked baggage|policy|hand baggage|cabin baggage|luggage|baggage information)\b/iu;
const AIRLINE_FOOTER_MARKER_PATTERN =
  /(newsletter|download the .* app|follow us on|how would you rate your experience on our website|payment methods|copyright|all rights reserved)/iu;
const DIRECTORY_ROW_START_PATTERN = /^!\[[^\]]*\]\([^)]+\)(.+)$/u;
const DIRECTORY_FIELD_KEY_BY_LABEL = new Map([
  ["destinations", "destinations"],
  ["carryon", "carryOn"],
  ["carry-on", "carryOn"],
  ["1st bag", "firstBag"],
  ["2nd bag", "secondBag"],
  ["additional policy", "additionalPolicy"],
]);
const STRUCTURED_POLICY_SOURCE_TYPES = new Set([
  "privacy_policy",
  "cookie_policy",
  "terms_conditions",
]);

function normalizeText(text) {
  return String(text || "").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function trimMarkdownDecorators(text) {
  return String(text || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[*_`>#]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function markdownLinks(text) {
  return [...String(text || "").matchAll(/\[[^\]]+\]\((https?:[^)]+)\)/gu)].map(
    (match) => match[1],
  );
}

function slugify(value) {
  return trimMarkdownDecorators(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
}

function compactSectionPath(path) {
  return path
    .filter((entry) => typeof entry === "string")
    .map((entry) => trimMarkdownDecorators(entry))
    .filter(Boolean);
}

function detectSourceType(url) {
  if (/\/info\/privacy/iu.test(url)) {
    return "privacy_policy";
  }

  if (/\/info\/cookie-policy\/?$/iu.test(url)) {
    return "cookie_policy";
  }

  if (/\/info\/generaltermsandconditions\/?$/iu.test(url)) {
    return "terms_conditions";
  }

  if (/\/travel\/baggage-fees\/?$/iu.test(url)) {
    return "baggage_directory";
  }

  return "airline_policy";
}

function splitMarkdownBlocks(markdown) {
  const lines = normalizeText(markdown).split("\n");
  const blocks = [];
  let buffer = [];

  function flushParagraph() {
    if (!buffer.length) {
      return;
    }

    const text = buffer.join("\n").trim();
    if (text) {
      blocks.push({ type: "paragraph", text });
    }

    buffer = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/u);

    if (headingMatch) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: trimMarkdownDecorators(headingMatch[2]),
      });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    buffer.push(line);
  }

  flushParagraph();
  return blocks;
}

function removeTableOfContents(lines) {
  const firstHeadingIndex = lines.findIndex((line) => /^(#{1,6})\s+/u.test(line));
  if (firstHeadingIndex < 0) {
    return lines;
  }

  const tocStart = firstHeadingIndex + 1;
  let tocEnd = tocStart;
  let tocLinkCount = 0;

  while (tocEnd < lines.length) {
    const line = lines[tocEnd];
    if (/^(#{1,6})\s+/u.test(line)) {
      break;
    }

    const trimmed = line.trim();
    if (trimmed && /^[-*]\s+\[[^\]]+\]\([^)]+\)/u.test(trimmed)) {
      tocLinkCount += 1;
    }

    tocEnd += 1;
  }

  if (tocLinkCount < 3) {
    return lines;
  }

  return [...lines.slice(0, firstHeadingIndex + 1), ...lines.slice(tocEnd)];
}

function promotePrivacySubheadings(lines) {
  return lines.map((line) => {
    const trimmed = line.trim();
    const match = trimmed.match(PRIVACY_SUBHEADING_PATTERN);
    if (!match) {
      return line;
    }

    return `#### ${trimMarkdownDecorators(match[1])}`;
  });
}

function trimPrivacyTail(lines) {
  const markerIndex = lines.findIndex((line) =>
    PRIVACY_FOOTER_MARKER_PATTERN.test(trimMarkdownDecorators(line)),
  );

  if (markerIndex < 0) {
    return lines;
  }

  return lines.slice(0, markerIndex);
}

function trimAirlinePolicyLead(lines) {
  const candidateIndex = lines.findIndex((line, index) => {
    if (index <= 0) {
      return false;
    }

    return AIRLINE_CONTENT_HEADING_PATTERN.test(line.trim());
  });

  if (candidateIndex < 0) {
    return lines;
  }

  return lines.slice(candidateIndex);
}

function trimAirlinePolicyTail(lines) {
  const markerIndex = lines.findIndex((line) =>
    AIRLINE_FOOTER_MARKER_PATTERN.test(trimMarkdownDecorators(line)),
  );

  if (markerIndex < 0) {
    return lines;
  }

  return lines.slice(0, markerIndex);
}

function cleanupMarkdown(text, sourceType) {
  let lines = normalizeText(text).split("\n");
  const firstHeadingIndex = lines.findIndex((line) => /^(#{1,6})\s+/u.test(line));

  if (firstHeadingIndex > 0) {
    lines = lines.slice(firstHeadingIndex);
  }

  if (sourceType === "privacy_policy") {
    lines = removeTableOfContents(lines);
    lines = trimPrivacyTail(lines);
    lines = promotePrivacySubheadings(lines);
  }

  if (STRUCTURED_POLICY_SOURCE_TYPES.has(sourceType)) {
    lines = removeTableOfContents(lines);
  }

  if (sourceType === "airline_policy") {
    lines = trimAirlinePolicyLead(lines);
    lines = trimAirlinePolicyTail(lines);
  }

  const cleaned = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const simplified = trimMarkdownDecorators(line);

    if (!line.trim()) {
      cleaned.push("");
      continue;
    }

    const linkCount = markdownLinks(line).length;
    const isLinkHeavy =
      linkCount >= 2 &&
      !/^(#{1,6})\s+/u.test(line) &&
      simplified.length < 80 * linkCount;

    if (NAVIGATION_LINE_PATTERN.test(simplified.toLowerCase())) {
      continue;
    }

    if (sourceType === "airline_policy" && isLinkHeavy) {
      continue;
    }

    if (
      sourceType === "airline_policy" &&
      simplified.length < 3 &&
      !/^(#{1,6})\s+/u.test(line)
    ) {
      continue;
    }

    cleaned.push(line);
  }

  return cleaned.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function updateHeadingStack(stack, level, text) {
  const next = stack.slice(0, Math.max(0, level - 1));
  next[level - 1] = text;
  return next;
}

function collectOverlapParagraphs(paragraphs, overlapChars) {
  if (!overlapChars || !paragraphs.length) {
    return [];
  }

  const overlap = [];
  let total = 0;

  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    overlap.unshift(paragraphs[index]);
    total += paragraphs[index].length;

    if (total >= overlapChars) {
      break;
    }
  }

  return overlap;
}

function buildChunkText(leadHeading, paragraphs) {
  return [leadHeading, ...paragraphs].filter(Boolean).join("\n\n").trim();
}

function classifyQuality({ doc, cleanedText }) {
  const title = doc.title || "";
  const statusCode = doc.metadata?.statusCode ?? null;
  const base = {
    qualityStatus: "usable",
    authority: doc.sourceType === "baggage_directory" ? "discovery_only" : "primary",
    retrievalAllowed: true,
  };

  if (doc.sourceType === "baggage_directory") {
    return base;
  }

  if (
    (statusCode && statusCode >= 400) ||
    UNUSABLE_TITLE_PATTERN.test(title) ||
    UNUSABLE_TEXT_PATTERN.test(cleanedText) ||
    cleanedText.length < 150
  ) {
    return {
      qualityStatus: "unusable",
      authority: "unusable",
      retrievalAllowed: false,
    };
  }

  return base;
}

function bestAirlineSegment(title, url) {
  const hostTokens = slugify(new URL(url).hostname)
    .split("-")
    .filter(Boolean);
  const segments = trimMarkdownDecorators(title)
    .split(/\s+\|\s+|\s+-\s+|:\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) {
    return hostTokens[0] || "unknown-airline";
  }

  const genericTokens = new Set([
    "baggage",
    "bag",
    "bags",
    "allowance",
    "allowances",
    "policy",
    "policies",
    "information",
    "travel",
    "services",
    "service",
    "help",
    "centre",
    "center",
  ]);

  let best = segments[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const segment of segments) {
    const tokens = slugify(segment).split("-").filter(Boolean);
    let score = tokens.length;

    for (const token of tokens) {
      if (genericTokens.has(token)) {
        score -= 2;
      }

      if (hostTokens.includes(token)) {
        score += 2;
      }
    }

    if (score > bestScore) {
      best = segment;
      bestScore = score;
    }
  }

  return best;
}

function metadataSiteName(metadata = {}) {
  const crawlMetadata = metadata?.crawlMetadata || {};
  const candidates = [
    crawlMetadata["og:site_name"],
    crawlMetadata["twitter:site"],
    crawlMetadata["application-name"],
    crawlMetadata.publisher,
  ]
    .map((value) => trimMarkdownDecorators(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (
      !/\b(baggage|allowance|policy|travel info|travel information|cabin|checked)\b/iu.test(
        candidate,
      )
    ) {
      return candidate;
    }
  }

  return null;
}

function deriveAirlineName({ title, url, metadata = {} }) {
  const siteName = metadataSiteName(metadata);
  if (siteName) {
    return siteName
      .replace(/\b(home|official site)\b/giu, "")
      .trim();
  }

  const segment = bestAirlineSegment(title, url);
  return trimMarkdownDecorators(segment)
    .replace(/\b(home|official site)\b/giu, "")
    .trim();
}

function normalizeDocument(rawDoc, options = {}) {
  const sourceType = options.sourceType || detectSourceType(rawDoc.url);
  const canonicalUrl =
    options.canonicalUrl ||
    rawDoc.metadata?.redirectedUrl ||
    rawDoc.url;
  const redirectedUrl = rawDoc.metadata?.redirectedUrl || null;
  const cleanedText = cleanupMarkdown(rawDoc.cleanedText || "", sourceType);
  const airlineName =
    options.airlineName ||
    (sourceType === "airline_policy"
      ? deriveAirlineName({
          title: rawDoc.title,
          url: canonicalUrl,
          metadata: rawDoc.metadata || {},
        })
      : null);
  const quality = classifyQuality({ doc: { ...rawDoc, sourceType }, cleanedText });

  return {
    ...rawDoc,
    canonicalUrl,
    redirectedUrl,
    sourceType,
    airlineName,
    airlineSlug: airlineName ? slugify(airlineName) : null,
    cleanedText,
    ...quality,
  };
}

function buildSections(doc, options = {}) {
  const text = doc.cleanedText;
  if (!text) {
    return [];
  }

  const targetChars = options.targetChars || 2200;
  const overlapChars = options.overlapChars || 200;
  const blocks = splitMarkdownBlocks(text);
  const sections = [];
  let headingStack = [];
  let pendingHeading = null;
  let currentParagraphs = [];
  let currentLeadHeading = null;
  let currentSectionPath = [];
  let sectionIndex = 0;
  let partIndex = 0;

  function flushSection({ carryOverlap }) {
    if (!currentParagraphs.length) {
      return;
    }

    const compactPath = compactSectionPath(currentSectionPath);
    const sectionTitle = compactPath.at(-1) || doc.title || "General";
    const chunkText = buildChunkText(currentLeadHeading, currentParagraphs);
    const sectionId = hashToUuid(`${doc.docId}:section:${sectionIndex}:${partIndex}`);

    sections.push({
      id: sectionId,
      sectionId,
      docId: doc.docId,
      url: doc.url,
      canonicalUrl: doc.canonicalUrl,
      redirectedUrl: doc.redirectedUrl,
      domain: getDomain(doc.canonicalUrl || doc.url),
      title: doc.title,
      airlineName: doc.airlineName,
      airlineSlug: doc.airlineSlug,
      sourceType: doc.sourceType,
      authority: doc.authority,
      qualityStatus: doc.qualityStatus,
      retrievalAllowed: doc.retrievalAllowed,
      fetchedAt: doc.fetchedAt,
      contentHash: doc.contentHash,
      sectionIndex,
      partIndex,
      sectionTitle,
      sectionPath: compactPath,
      sectionSlug: slugify(sectionTitle) || "general",
      anchorText: sectionTitle,
      text: chunkText,
      textHash: sha256(chunkText),
      statusCode: doc.metadata?.statusCode ?? null,
    });

    if (carryOverlap) {
      currentParagraphs = collectOverlapParagraphs(currentParagraphs, overlapChars);
      partIndex += 1;
    } else {
      currentParagraphs = [];
      currentLeadHeading = null;
      currentSectionPath = [];
      sectionIndex += 1;
      partIndex = 0;
    }
  }

  for (const block of blocks) {
    if (block.type === "heading") {
      if (currentParagraphs.length) {
        flushSection({ carryOverlap: false });
      }

      headingStack = updateHeadingStack(headingStack, block.level, block.text);
      pendingHeading = `${"#".repeat(block.level)} ${block.text}`;
      continue;
    }

    if (!currentParagraphs.length) {
      currentSectionPath = compactSectionPath(headingStack);
      currentLeadHeading = pendingHeading;
      pendingHeading = null;
    }

    const nextParagraphs = [...currentParagraphs, block.text];
    const prospectiveText = buildChunkText(currentLeadHeading, nextParagraphs);

    if (
      currentParagraphs.length > 0 &&
      prospectiveText.length > targetChars
    ) {
      flushSection({ carryOverlap: true });

      if (!currentParagraphs.length) {
        currentSectionPath = compactSectionPath(headingStack);
        currentLeadHeading =
          pendingHeading ||
          currentLeadHeading ||
          (currentSectionPath.length
            ? `## ${currentSectionPath.at(-1)}`
            : null);
      }
    }

    if (!currentParagraphs.length) {
      currentSectionPath = compactSectionPath(headingStack);
      currentLeadHeading =
        pendingHeading ||
        currentLeadHeading ||
        (currentSectionPath.length ? `## ${currentSectionPath.at(-1)}` : null);
      pendingHeading = null;
    }

    currentParagraphs.push(block.text);
  }

  flushSection({ carryOverlap: false });

  if (!sections.length) {
    const sectionId = hashToUuid(`${doc.docId}:section:0:0`);
    return [
      {
        id: sectionId,
        sectionId,
        docId: doc.docId,
        url: doc.url,
        canonicalUrl: doc.canonicalUrl,
        redirectedUrl: doc.redirectedUrl,
        domain: getDomain(doc.canonicalUrl || doc.url),
        title: doc.title,
        airlineName: doc.airlineName,
        airlineSlug: doc.airlineSlug,
        sourceType: doc.sourceType,
        authority: doc.authority,
        qualityStatus: doc.qualityStatus,
        retrievalAllowed: doc.retrievalAllowed,
        fetchedAt: doc.fetchedAt,
        contentHash: doc.contentHash,
        sectionIndex: 0,
        partIndex: 0,
        sectionTitle: doc.title || "General",
        sectionPath: doc.title ? [doc.title] : [],
        sectionSlug: slugify(doc.title || "general"),
        anchorText: doc.title || "General",
        text,
        textHash: sha256(text),
        statusCode: doc.metadata?.statusCode ?? null,
      },
    ];
  }

  return sections;
}

function pickFactSentence(text, facet) {
  const sentences = text
    .replace(/\n+/gu, " ")
    .split(/(?<=[.?!])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const entry = BAGGAGE_FACETS.find((candidate) => candidate.facet === facet);
  const matches = sentences.filter((sentence) => entry?.pattern.test(sentence));

  if (matches.length) {
    return matches.slice(0, 2).join(" ");
  }

  return sentences.slice(0, 2).join(" ").slice(0, 500).trim();
}

function extractBaggageFacts(doc, sections) {
  if (doc.sourceType !== "airline_policy" || !doc.retrievalAllowed) {
    return [];
  }

  const facts = [];

  for (const section of sections) {
    for (const entry of BAGGAGE_FACETS) {
      const searchable = `${section.sectionTitle}\n${section.text}`;
      if (!entry.pattern.test(searchable)) {
        continue;
      }

      const valueText = pickFactSentence(section.text, entry.facet);
      if (!valueText) {
        continue;
      }

      const factId = hashToUuid(`${section.sectionId}:${entry.facet}`);
      facts.push({
        id: factId,
        factId,
        sectionId: section.sectionId,
        docId: doc.docId,
        url: doc.url,
        canonicalUrl: doc.canonicalUrl,
        title: doc.title,
        sourceType: doc.sourceType,
        airlineName: doc.airlineName,
        facet: entry.facet,
        valueText,
        conditions: null,
        units: null,
        effectiveDate: null,
        retrievalAllowed: doc.retrievalAllowed,
      });
    }
  }

  return Object.values(
    facts.reduce((accumulator, fact) => {
      accumulator[fact.factId] = fact;
      return accumulator;
    }, {}),
  );
}

function parseDirectoryFieldLabel(line) {
  const simplified = trimMarkdownDecorators(line)
    .replace(/:$/u, "")
    .trim()
    .toLowerCase();

  return DIRECTORY_FIELD_KEY_BY_LABEL.get(simplified) || null;
}

function extractInlineAirlineName(line) {
  const match = String(line || "").match(DIRECTORY_ROW_START_PATTERN);
  if (!match) {
    return null;
  }

  const airlineName = trimMarkdownDecorators(match[1]);
  if (!airlineName || DIRECTORY_LABEL_PATTERN.test(airlineName)) {
    return null;
  }

  return airlineName;
}

function dedupeFieldLines(lines) {
  const seen = new Set();
  const deduped = [];

  for (const line of lines) {
    const normalized = normalizeText(line)
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(" ");
    const key = normalized.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(line.trim());
  }

  return deduped;
}

function simplifyFieldLines(lines) {
  return dedupeFieldLines(lines)
    .map((line) => trimMarkdownDecorators(line))
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

function firstUniqueUrl(lines) {
  return [...new Set(lines.flatMap((line) => markdownLinks(line)))][0] || null;
}

function extractCarryOnDetails(lines) {
  const simplified = simplifyFieldLines(lines);
  const detailMap = new Map();

  for (const line of simplified) {
    const match = line.match(/^(Cost|Weight|Size|Notes)\s*:\s*(.+)$/iu);
    if (!match) {
      continue;
    }

    const key = match[1].toLowerCase();
    if (!detailMap.has(key)) {
      detailMap.set(key, match[2].trim());
    }
  }

  return {
    cost: detailMap.get("cost") || null,
    weight: detailMap.get("weight") || null,
    size: detailMap.get("size") || null,
    notes: detailMap.get("notes") || null,
  };
}

function buildDirectoryRowTexts({
  airlineName,
  routeScope,
  carryOnText,
  carryOnCost,
  carryOnWeight,
  carryOnSize,
  carryOnNotes,
  firstBagUrl,
  secondBagUrl,
  additionalPolicyUrl,
}) {
  const rowLines = [
    `Airline: ${airlineName}`,
    routeScope ? `Destinations: ${routeScope}` : null,
    carryOnText && !carryOnCost && !carryOnWeight && !carryOnSize && !carryOnNotes
      ? `CarryOn: ${carryOnText}`
      : "CarryOn:",
    carryOnCost ? `**Cost:** ${carryOnCost}` : null,
    carryOnCost ? `Cost: ${carryOnCost}` : null,
    carryOnWeight ? `**Weight:** ${carryOnWeight}` : null,
    carryOnWeight ? `Weight: ${carryOnWeight}` : null,
    carryOnSize ? `**Size:** ${carryOnSize}` : null,
    carryOnSize ? `Size: ${carryOnSize}` : null,
    carryOnNotes ? `**Notes:** ${carryOnNotes}` : null,
    carryOnNotes ? `Notes: ${carryOnNotes}` : null,
    firstBagUrl ? `1st Bag Policy: ${firstBagUrl}` : null,
    secondBagUrl ? `2nd Bag Policy: ${secondBagUrl}` : null,
    additionalPolicyUrl ? `Additional Policy: ${additionalPolicyUrl}` : null,
  ].filter(Boolean);

  const embeddingLines = [
    `Airline: ${airlineName}`,
    routeScope ? `Destinations: ${routeScope}` : null,
    carryOnText ? `CarryOn: ${carryOnText}` : "CarryOn: View policy",
    carryOnCost ? `CarryOn Cost: ${carryOnCost}` : null,
    carryOnWeight ? `CarryOn Weight: ${carryOnWeight}` : null,
    carryOnSize ? `CarryOn Size: ${carryOnSize}` : null,
    carryOnNotes ? `CarryOn Notes: ${carryOnNotes}` : null,
    firstBagUrl ? `1st Bag Policy: ${firstBagUrl}` : null,
    secondBagUrl ? `2nd Bag Policy: ${secondBagUrl}` : null,
    additionalPolicyUrl ? `Additional Policy: ${additionalPolicyUrl}` : null,
  ].filter(Boolean);

  return {
    rowText: rowLines.join("\n"),
    embeddingText: embeddingLines.join("\n"),
  };
}

function buildDirectoryRowRecord(doc, row, rowIndex) {
  const routeScope = simplifyFieldLines(row.fields.destinations).join(" ").trim() || null;
  const carryOnLines = dedupeFieldLines(row.fields.carryOn);
  const carryOnSimple = simplifyFieldLines(carryOnLines);
  const carryOnText = carryOnSimple.join(" ").trim() || null;
  const carryOnDetails = extractCarryOnDetails(carryOnLines);
  const firstBagUrl = firstUniqueUrl(row.fields.firstBag);
  const secondBagUrl = firstUniqueUrl(row.fields.secondBag);
  const additionalPolicyUrl = firstUniqueUrl(row.fields.additionalPolicy);
  const { rowText, embeddingText } = buildDirectoryRowTexts({
    airlineName: row.airlineName,
    routeScope,
    carryOnText,
    carryOnCost: carryOnDetails.cost,
    carryOnWeight: carryOnDetails.weight,
    carryOnSize: carryOnDetails.size,
    carryOnNotes: carryOnDetails.notes,
    firstBagUrl,
    secondBagUrl,
    additionalPolicyUrl,
  });
  const routeSlug = slugify(routeScope || `row-${rowIndex}`) || `row-${rowIndex}`;
  const rowId = hashToUuid(
    `${doc.docId}:row:${row.airlineSlug}:${routeSlug}:${rowIndex}`,
  );

  return {
    id: rowId,
    rowId,
    sectionId: rowId,
    docId: doc.docId,
    url: doc.url,
    canonicalUrl: doc.canonicalUrl,
    redirectedUrl: doc.redirectedUrl,
    domain: getDomain(doc.canonicalUrl || doc.url),
    title: doc.title,
    airlineName: row.airlineName,
    airlineSlug: row.airlineSlug,
    sourceUrl: doc.url,
    sourceType: "baggage_directory_row",
    authority: doc.authority,
    qualityStatus: doc.qualityStatus,
    retrievalAllowed: doc.retrievalAllowed,
    fetchedAt: doc.fetchedAt,
    contentHash: doc.contentHash,
    chunkIndex: rowIndex,
    sectionIndex: rowIndex,
    partIndex: 0,
    sectionTitle: row.airlineName,
    sectionPath: [doc.title || "Baggage Fees", row.airlineName, routeScope].filter(
      Boolean,
    ),
    sectionSlug: row.airlineSlug,
    anchorText: row.airlineName,
    routeScope,
    carryOnText,
    carryOnCost: carryOnDetails.cost,
    carryOnWeight: carryOnDetails.weight,
    carryOnSize: carryOnDetails.size,
    carryOnNotes: carryOnDetails.notes,
    firstBagUrl,
    secondBagUrl,
    additionalPolicyUrl,
    rowText,
    embeddingText,
    text: rowText,
    textHash: sha256(rowText),
  };
}

function extractBaggageDirectoryRows(doc) {
  if (doc.sourceType !== "baggage_directory" || !doc.retrievalAllowed) {
    return [];
  }

  const lines = normalizeText(doc.cleanedText).split("\n");
  const rows = [];
  let current = null;
  let currentField = null;

  function flushCurrent() {
    if (!current) {
      return;
    }

    rows.push(
      buildDirectoryRowRecord(doc, current, rows.length),
    );
    current = null;
    currentField = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const airlineName = extractInlineAirlineName(line);

    if (airlineName) {
      flushCurrent();
      current = {
        airlineName,
        airlineSlug: slugify(airlineName),
        fields: {
          destinations: [],
          carryOn: [],
          firstBag: [],
          secondBag: [],
          additionalPolicy: [],
        },
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const field = parseDirectoryFieldLabel(line);
    if (field) {
      currentField = field;
      continue;
    }

    if (!line.trim() || !currentField) {
      continue;
    }

    current.fields[currentField].push(line);
  }

  flushCurrent();

  return rows.filter(
    (row) =>
      row.airlineName &&
      (row.routeScope || row.carryOnText || row.firstBagUrl || row.additionalPolicyUrl),
  );
}

function extractAirlineRegistry(doc) {
  if (doc.sourceType === "airline_policy" && doc.airlineName) {
    const registryId = hashToUuid(`${doc.docId}:registry:${doc.airlineSlug}`);
    return [
      {
        id: registryId,
        registryId,
        docId: doc.docId,
        airlineName: doc.airlineName,
        airlineSlug: doc.airlineSlug,
        sourceUrl: doc.url,
        canonicalUrl: doc.canonicalUrl,
        rowText: doc.title,
        policyUrls: [doc.canonicalUrl || doc.url],
        crawlStatus: doc.qualityStatus,
      },
    ];
  }

  if (doc.sourceType !== "baggage_directory") {
    return [];
  }

  return extractBaggageDirectoryRows(doc)
    .map((row) => {
      const policyUrls = [
        row.firstBagUrl,
        row.secondBagUrl,
        row.additionalPolicyUrl,
      ].filter(Boolean);

      return {
        id: hashToUuid(`${doc.docId}:registry:${row.airlineSlug}:${slugify(row.routeScope || row.rowId)}`),
        registryId: hashToUuid(
          `${doc.docId}:registry:${row.airlineSlug}:${slugify(row.routeScope || row.rowId)}`,
        ),
        docId: doc.docId,
        airlineName: row.airlineName,
        airlineSlug: row.airlineSlug,
        sourceUrl: doc.url,
        canonicalUrl: doc.canonicalUrl,
        rowText: row.rowText,
        policyUrls: [...new Set(policyUrls)],
        crawlStatus: "discovered",
      };
    })
    .filter((entry) => entry.policyUrls.length);
}

function buildHybridArtifacts(rawDoc, options = {}) {
  const document = normalizeDocument(rawDoc, options);
  const sections = buildSections(document, options);
  const directoryRows = extractBaggageDirectoryRows(document);
  const airlineRegistry = extractAirlineRegistry(document);
  const facts = extractBaggageFacts(document, sections);

  return {
    document,
    sections,
    directoryRows,
    airlineRegistry,
    facts,
  };
}

  return { deriveAirlineName, normalizeDocument, buildSections, extractBaggageFacts, extractBaggageDirectoryRows, extractAirlineRegistry, buildHybridArtifacts };
})();
const __vectorDocumentsModule = (() => {
const { chunkDocument } = __chunkerModule;
const { extractBaggageDirectoryRows, normalizeDocument } = __hybridDocumentsModule;

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
}

function enrichChunk(document, chunk) {
  const sectionPath = Array.isArray(chunk.sectionPath)
    ? chunk.sectionPath.filter(Boolean)
    : [];
  const sectionTitle = sectionPath.length ? sectionPath.at(-1) : null;

  return {
    ...chunk,
    canonicalUrl: document.canonicalUrl,
    redirectedUrl: document.redirectedUrl,
    sourceType: document.sourceType,
    authority: document.authority,
    qualityStatus: document.qualityStatus,
    retrievalAllowed: document.retrievalAllowed,
    airlineName: document.airlineName,
    airlineSlug: document.airlineSlug,
    sectionId: chunk.id,
    sectionIndex: chunk.chunkIndex,
    partIndex: 0,
    sectionTitle,
    sectionSlug: sectionTitle ? slugify(sectionTitle) : null,
    anchorText: sectionTitle,
  };
}

function buildVectorArtifacts(rawDoc, options = {}) {
  const document = normalizeDocument(rawDoc, options);
  const chunks = chunkDocument(document, options).map((chunk) =>
    enrichChunk(document, chunk),
  );
  const directoryRows = extractBaggageDirectoryRows(document);
  const records =
    document.sourceType === "baggage_directory"
      ? [...directoryRows, ...chunks]
      : [...chunks];

  return {
    document,
    chunks,
    directoryRows,
    records,
  };
}

  return { buildVectorArtifacts };
})();
const __crawl4aiResultModule = (() => {
const { extractTitleFromMarkdown } = __chunkerModule;
const { hashToUuid, sha256 } = __hashModule;
const { getDomain } = __urlModule;

function firstDefined(values) {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim() === ""),
  );
}

function pickResultPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  if (Array.isArray(payload)) {
    return pickResultPayload(payload[0]);
  }

  if (Array.isArray(payload.results)) {
    return pickResultPayload(payload.results[0]);
  }

  if (Array.isArray(payload.data)) {
    return pickResultPayload(payload.data[0]);
  }

  if (payload.result && payload.result !== payload) {
    return pickResultPayload(payload.result);
  }

  return payload;
}

function extractCleanedText(result) {
  const candidates = [
    ["markdown.fit_markdown", result?.markdown?.fit_markdown],
    ["markdown.raw_markdown", result?.markdown?.raw_markdown],
    ["markdown", typeof result?.markdown === "string" ? result.markdown : null],
    ["cleaned_text", result?.cleaned_text],
    ["text", result?.text],
    ["content", result?.content],
    ["extracted_content", result?.extracted_content],
  ];

  const selected = candidates.find(
    ([, value]) =>
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim() === ""),
  );

  return {
    source: selected?.[0] || null,
    text: selected?.[1] || null,
  };
}

function buildRawDocFromCrawlResult({
  url,
  result,
  fetchedAt = new Date().toISOString(),
  taskId = null,
  source = "crawl4ai",
}) {
  const extracted = extractCleanedText(result);
  const cleanedText = extracted.text?.trim();

  if (!cleanedText) {
    throw new Error(`Crawl completed for ${url}, but no text was extracted.`);
  }

  const title =
    firstDefined([
      result?.metadata?.title,
      result?.title,
      extractTitleFromMarkdown(cleanedText),
    ]) || "Untitled";

  return {
    extracted,
    title,
    rawDoc: {
      docId: hashToUuid(url),
      url,
      domain: getDomain(url),
      title,
      fetchedAt,
      cleanedText,
      contentHash: sha256(cleanedText),
      metadata: {
        taskId,
        source,
        status: result?.success === false ? "failed" : "completed",
        crawlMetadata: result?.metadata || {},
        statusCode: result?.status_code ?? null,
        redirectedUrl: result?.redirected_url || null,
      },
    },
  };
}

  return { firstDefined, pickResultPayload, extractCleanedText, buildRawDocFromCrawlResult };
})();
const __openAiServiceModule = (() => {
function postJson(...args) {
  return globalThis.__indexingInternals.postJson(...args);
}

function requiredApiKey(apiKey) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for embeddings and chat.");
  }

  return apiKey;
}

function buildHeaders(apiKey) {
  return {
    authorization: `Bearer ${requiredApiKey(apiKey)}`,
  };
}

class OpenAIService {
  constructor(config) {
    this.apiKey = config.openAiApiKey;
    this.baseUrl = config.openAiBaseUrl.replace(/\/+$/u, "");
    this.embeddingModel = config.openAiEmbeddingModel;
    this.chatModel = config.openAiChatModel;
    this.sdkClient = null;
    this.hydeAgent = null;
  }

  async createEmbeddings(inputs) {
    const response = await postJson(
      `${this.baseUrl}/embeddings`,
      {
        model: this.embeddingModel,
        input: inputs,
      },
      buildHeaders(this.apiKey),
    );

    const vectors = response?.data?.map((item) => item.embedding);

    if (!vectors?.length) {
      throw new Error("OpenAI embeddings response was empty.");
    }

    return vectors;
  }

  hasEmbeddingSupport() {
    return Boolean(this.apiKey);
  }

  hasChatSupport() {
    return Boolean(this.apiKey);
  }

  getEmbeddingConfig() {
    return {
      baseUrl: this.baseUrl,
      model: this.embeddingModel,
    };
  }

  getSdkClient() {
    if (!this.sdkClient) {
      this.sdkClient = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
        timeout: 120_000,
      });
    }

    return this.sdkClient;
  }

  getHydeAgent() {
    if (!this.hydeAgent) {
      this.hydeAgent = new Agent({
        name: "HyDE Passage Generator",
        model: this.chatModel,
        instructions:
          "Write one concise hypothetical passage that could plausibly appear in the source document needed to answer the user's question. Use source-like language and concrete details. Do not mention that the passage is hypothetical. Do not answer conversationally.",
        modelSettings: {
          temperature: 0.2,
        },
      });
    }

    return this.hydeAgent;
  }

  async generateHypotheticalDocument({ query, filter = {} }) {
    const scope = [
      filter.sourceType ? `Source type: ${filter.sourceType}` : null,
      filter.domain ? `Domain: ${filter.domain}` : null,
      filter.url ? `URL: ${filter.url}` : null,
      filter.airline ? `Airline: ${filter.airline}` : null,
      filter.facet ? `Facet: ${filter.facet}` : null,
      filter.privacyAspect ? `Privacy aspect: ${filter.privacyAspect}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    setOpenAIAPI("chat_completions");
    setDefaultOpenAIClient(this.getSdkClient());

    const result = await run(
      this.getHydeAgent(),
      [
        scope || "Source type: general web page",
        `Question: ${query}`,
        "Write one short passage that looks like grounded source content.",
      ].join("\n"),
      { maxTurns: 1 },
    );

    const content = String(result.finalOutput || "").trim();

    if (!content) {
      throw new Error("OpenAI HyDE generation response was empty.");
    }

    return content;
  }

  async generateGroundedAnswer({ query, history = [], chunks }) {
    if (!chunks.length) {
      return "I could not find any relevant indexed content for that question.";
    }

    const formattedContext = chunks
      .map((chunk, index) => {
        const section = chunk.sectionPath?.length
          ? chunk.sectionPath.join(" > ")
          : "General";
        const fact = chunk.matchedFact
          ? [
              `Fact facet: ${chunk.matchedFact.facet}`,
              `Fact value: ${chunk.matchedFact.valueText}`,
            ].join("\n")
          : null;

        return [
          `[${index + 1}]`,
          `URL: ${chunk.url}`,
          `Title: ${chunk.title}`,
          `Source Type: ${chunk.sourceType || "unknown"}`,
          `Airline: ${chunk.airlineName || "n/a"}`,
          `Route Scope: ${chunk.routeScope || "n/a"}`,
          `Section: ${section}`,
          `Chunk: ${chunk.chunkIndex}`,
          fact,
          `Text: ${chunk.text}`,
        ].join("\n");
      })
      .join("\n\n");

    const sanitizedHistory = history
      .filter(
        (message) =>
          message &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string" &&
          message.content.trim(),
      )
      .slice(-8)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const response = await postJson(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.chatModel,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You answer only from the retrieved context. If the answer is not in the context, say you do not know. Cite every material claim with chunk markers like [1] or [2]. Do not invent sources.",
          },
          ...sanitizedHistory,
          {
            role: "user",
            content: [
              "Retrieved context:",
              formattedContext,
              "",
              `Question: ${query}`,
              "Answer with concise citations tied to the chunk numbers.",
            ].join("\n"),
          },
        ],
      },
      buildHeaders(this.apiKey),
    );

    const content = response?.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error("OpenAI chat response was empty.");
    }

    return content;
  }
}

  return { OpenAIService };
})();
const __qdrantServiceModule = (() => {
function getJson(...args) {
  return globalThis.__indexingInternals.getJson(...args);
}

function postJson(...args) {
  return globalThis.__indexingInternals.postJson(...args);
}

function putJson(...args) {
  return globalThis.__indexingInternals.putJson(...args);
}

function requestJson(...args) {
  return globalThis.__indexingInternals.requestJson(...args);
}

function collectionVectorSize(payload) {
  const vectors = payload?.result?.config?.params?.vectors;

  if (!vectors) {
    return null;
  }

  if (typeof vectors.size === "number") {
    return vectors.size;
  }

  if (typeof vectors === "object") {
    const firstVector = Object.values(vectors)[0];
    return firstVector?.size || null;
  }

  return null;
}

function buildPayloadFilter(filter = {}) {
  const must = [];

  if (filter.url) {
    must.push({
      key: "url",
      match: { value: filter.url },
    });
  }

  if (filter.domain) {
    must.push({
      key: "domain",
      match: { value: filter.domain },
    });
  }

  if (filter.sourceType) {
    must.push({
      key: "sourceType",
      match: { value: filter.sourceType },
    });
  }

  if (filter.airline) {
    must.push({
      key: "airlineName",
      match: { value: filter.airline },
    });
  }

  if (filter.rowId) {
    must.push({
      key: "rowId",
      match: { value: filter.rowId },
    });
  }

  if (typeof filter.retrievalAllowed === "boolean") {
    must.push({
      key: "retrievalAllowed",
      match: { value: filter.retrievalAllowed },
    });
  }

  if (!must.length) {
    return undefined;
  }

  return { must };
}

class QdrantService {
  constructor(config) {
    this.baseUrl = config.qdrantUrl.replace(/\/+$/u, "");
    this.collection = config.qdrantCollection;
    this.headers = config.qdrantApiKey
      ? { "api-key": config.qdrantApiKey }
      : {};
  }

  async getCollectionInfo() {
    try {
      return await getJson(
        `${this.baseUrl}/collections/${this.collection}`,
        this.headers,
      );
    } catch (error) {
      if (error.statusCode === 404) {
        return null;
      }

      throw error;
    }
  }

  async deleteCollection() {
    try {
      return await requestJson(
        `${this.baseUrl}/collections/${this.collection}`,
        {
          method: "DELETE",
          headers: this.headers,
        },
      );
    } catch (error) {
      if (error.statusCode === 404) {
        return null;
      }

      throw error;
    }
  }

  async ensureCollection(vectorSize) {
    const current = await this.getCollectionInfo();

    if (!current) {
      await putJson(
        `${this.baseUrl}/collections/${this.collection}`,
        {
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
        },
        this.headers,
      );
      return {
        collection: this.collection,
        vectorSize,
        created: true,
      };
    }

    const existingSize = collectionVectorSize(current);
    if (existingSize && existingSize !== vectorSize) {
      throw new Error(
        `Qdrant collection ${this.collection} already exists with vector size ${existingSize}, expected ${vectorSize}.`,
      );
    }

    return {
      collection: this.collection,
      vectorSize: existingSize || vectorSize,
      created: false,
    };
  }

  async deleteDocument(docId) {
    let response;

    try {
      response = await postJson(
        `${this.baseUrl}/collections/${this.collection}/points/delete?wait=true`,
        {
          filter: {
            must: [
              {
                key: "docId",
                match: { value: docId },
              },
            ],
          },
        },
        this.headers,
      );
    } catch (error) {
      if (error.statusCode === 404) {
        return {
          collection: this.collection,
          docId,
          status: "missing_collection",
          operationId: null,
        };
      }

      throw error;
    }

    return {
      collection: this.collection,
      docId,
      status: response?.status || "unknown",
      operationId: response?.result?.operation_id || null,
    };
  }

  async upsertRecords(records, vectors) {
    if (records.length !== vectors.length) {
      throw new Error("Record count and embedding count do not match.");
    }

    const points = records.map((record, index) => ({
      id: record.id,
      vector: vectors[index],
      payload: {
        docId: record.docId,
        url: record.url,
        canonicalUrl: record.canonicalUrl || record.url,
        redirectedUrl: record.redirectedUrl || null,
        domain: record.domain,
        title: record.title,
        chunkIndex: record.chunkIndex ?? record.sectionIndex ?? 0,
        sectionId: record.sectionId || record.id,
        sectionIndex: record.sectionIndex ?? record.chunkIndex ?? 0,
        partIndex: record.partIndex ?? 0,
        sectionTitle: record.sectionTitle || null,
        sectionPath: record.sectionPath || [],
        sectionSlug: record.sectionSlug || null,
        anchorText: record.anchorText || null,
        text: record.text,
        fetchedAt: record.fetchedAt,
        contentHash: record.contentHash,
        textHash: record.textHash,
        sourceType: record.sourceType || null,
        authority: record.authority || null,
        qualityStatus: record.qualityStatus || null,
        retrievalAllowed: Boolean(record.retrievalAllowed),
        airlineName: record.airlineName || null,
        airlineSlug: record.airlineSlug || null,
        rowId: record.rowId || null,
        routeScope: record.routeScope || null,
        rowText: record.rowText || null,
        embeddingText: record.embeddingText || null,
        carryOnText: record.carryOnText || null,
        carryOnCost: record.carryOnCost || null,
        carryOnWeight: record.carryOnWeight || null,
        carryOnSize: record.carryOnSize || null,
        carryOnNotes: record.carryOnNotes || null,
        firstBagUrl: record.firstBagUrl || null,
        secondBagUrl: record.secondBagUrl || null,
        additionalPolicyUrl: record.additionalPolicyUrl || null,
      },
    }));

    const response = await putJson(
      `${this.baseUrl}/collections/${this.collection}/points?wait=true`,
      { points },
      this.headers,
    );

    return {
      collection: this.collection,
      pointCount: points.length,
      status: response?.status || "unknown",
      operationId: response?.result?.operation_id || null,
    };
  }

  async upsertChunks(chunks, vectors) {
    return this.upsertRecords(chunks, vectors);
  }

  async scrollPoints({ filter, limit = 256, withPayload = true, withVector = false }) {
    const points = [];
    let offset = null;

    while (true) {
      let response;

      try {
        response = await postJson(
          `${this.baseUrl}/collections/${this.collection}/points/scroll`,
          {
            limit,
            with_payload: withPayload,
            with_vector: withVector,
            filter: buildPayloadFilter(filter),
            offset,
          },
          this.headers,
        );
      } catch (error) {
        if (error.statusCode === 404) {
          return [];
        }

        throw error;
      }

      const batch = response?.result?.points || [];
      points.push(...batch);

      offset = response?.result?.next_page_offset || null;
      if (!offset || !batch.length) {
        break;
      }
    }

    return points;
  }

  async listAirlines({ sourceType = "airline_policy" } = {}) {
    const points = await this.scrollPoints({
      filter: {
        sourceType,
        retrievalAllowed: true,
      },
      limit: 512,
      withPayload: true,
      withVector: false,
    });
    const airlines = new Map();

    for (const point of points) {
      const airlineName = point.payload?.airlineName;
      const airlineSlug = point.payload?.airlineSlug;
      if (!airlineName) {
        continue;
      }

      const key = `${airlineName}::${airlineSlug || ""}`;
      if (!airlines.has(key)) {
        airlines.set(key, {
          airlineName,
          airlineSlug: airlineSlug || null,
        });
      }
    }

    return [...airlines.values()].sort((left, right) =>
      left.airlineName.localeCompare(right.airlineName),
    );
  }

  async listDirectoryRows({ airline } = {}) {
    const points = await this.scrollPoints({
      filter: {
        sourceType: "baggage_directory_row",
        airline,
        retrievalAllowed: true,
      },
      limit: 1024,
      withPayload: true,
      withVector: false,
    });

    return points.map((point) => ({
      id: point.id,
      score: point.score || 0,
      ...point.payload,
    }));
  }

  async query({ vector, topK, filter }) {
    let response;

    try {
      response = await postJson(
        `${this.baseUrl}/collections/${this.collection}/points/query`,
        {
          query: vector,
          limit: topK,
          with_payload: true,
          with_vector: false,
          filter: buildPayloadFilter(filter),
        },
        this.headers,
      );
    } catch (error) {
      if (error.statusCode === 404) {
        return [];
      }

      throw error;
    }

    const hits = response?.result?.points || response?.result || [];

    return hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      ...hit.payload,
    }));
  }
}

  return { buildPayloadFilter, QdrantService };
})();
const __runImportServiceModule = (() => {
const { join } = globalThis.__indexingInternals;
const { mapWithConcurrency } = __asyncModule;
const { buildRawDocFromCrawlResult, pickResultPayload } = __crawl4aiResultModule;
const { writeJson, readJson } = __filesModule;
const { buildVectorArtifacts } = __vectorDocumentsModule;
const { fileStemForUrl } = __urlModule;

function vectorEligibleRecords(records) {
  return records.filter((record) => record.retrievalAllowed);
}

class RunImportService {
  constructor({ config, openAiService, qdrantService }) {
    this.config = config;
    this.openAiService = openAiService;
    this.qdrantService = qdrantService;
  }

  async indexVectors(document, records) {
    const eligible = vectorEligibleRecords(records);
    if (!eligible.length || !this.openAiService.hasEmbeddingSupport()) {
      return {
        indexed: false,
        pointCount: 0,
      };
    }

    const vectors = await this.openAiService.createEmbeddings(
      eligible.map((record) => record.embeddingText || record.text),
    );

    await this.qdrantService.ensureCollection(vectors[0].length);
    await this.qdrantService.deleteDocument(document.docId);
    const upsert = await this.qdrantService.upsertRecords(eligible, vectors);

    return {
      indexed: true,
      pointCount: upsert.pointCount,
      vectorDimension: vectors[0].length,
    };
  }

  async importRunDirectory(runDir) {
    const resultIndexPath = join(runDir, "result-index.json");
    const rows = await readJson(resultIndexPath);
    const successfulRows = rows.filter(
      (row) => row.status === "success" && row.filePath,
    );

    const results = await mapWithConcurrency(
      successfulRows,
      this.config.ingestConcurrency,
      async (row) => {
        try {
          const stored = await readJson(row.filePath);
          const result = pickResultPayload(stored.response);
          const fetchedAt = stored.fetchedAt || new Date().toISOString();
          const { rawDoc } = buildRawDocFromCrawlResult({
            url: row.url,
            result,
            fetchedAt,
            source: "crawl4ai-run-import",
          });
          const artifacts = buildVectorArtifacts(rawDoc, this.config.chunking);
          const fileStem = fileStemForUrl(artifacts.document.canonicalUrl || row.url);
          const chunkPath = join(this.config.paths.chunksDir, `${fileStem}.json`);

          await writeJson(chunkPath, {
            document: artifacts.document,
            chunkCount: artifacts.chunks.length,
            rowCount: artifacts.directoryRows?.length || 0,
            recordCount: artifacts.records?.length || artifacts.chunks.length,
            chunks: artifacts.chunks,
            directoryRows: artifacts.directoryRows || [],
          });

          const vectorResult = await this.indexVectors(
            artifacts.document,
            artifacts.records || artifacts.chunks,
          );

          return {
            url: row.url,
            status: "indexed",
            sourceType: artifacts.document.sourceType,
            airlineName: artifacts.document.airlineName,
            chunkCount: artifacts.chunks.length,
            retrievalAllowed: artifacts.document.retrievalAllowed,
            qualityStatus: artifacts.document.qualityStatus,
            chunkPath,
            vectorIndexed: vectorResult.indexed,
            vectorPointCount: vectorResult.pointCount,
          };
        } catch (error) {
          return {
            url: row.url,
            status: "failed",
            error: error.message,
          };
        }
      },
    );

    return {
      runDir,
      total: successfulRows.length,
      indexed: results.filter((item) => item.status === "indexed").length,
      failed: results.filter((item) => item.status === "failed").length,
      results,
    };
  }
}

  return { RunImportService };
})();
const __ingestionServiceModule = (() => {
const { join } = globalThis.__indexingInternals;
const { mapWithConcurrency } = __asyncModule;
const { readJson, writeJson } = __filesModule;
const { buildVectorArtifacts } = __vectorDocumentsModule;
const { fileStemForUrl } = __urlModule;
const { buildChunkingSummary, createIngestionTrace } = __ingestionTraceModule;

async function readOptionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

class IngestionService {
  constructor({
    config,
    crawl4aiClient,
    openAiService,
    qdrantService,
    runImportService,
  }) {
    this.config = config;
    this.crawl4aiClient = crawl4aiClient;
    this.openAiService = openAiService;
    this.qdrantService = qdrantService;
    this.runImportService = runImportService;
  }

  async ingestRunDirectory(runDir) {
    return this.runImportService.importRunDirectory(runDir);
  }

  async ingestUrl(url, options = {}) {
    const fileStem = fileStemForUrl(url);
    const crawl4aiPath = join(this.config.paths.crawl4aiDir, `${fileStem}.json`);
    const rawPath = join(this.config.paths.rawDir, `${fileStem}.json`);
    const chunkPath = join(this.config.paths.chunksDir, `${fileStem}.json`);
    const trace = createIngestionTrace({
      config: this.config,
      url,
    });

    await trace.recordStep({
      stage: "pipeline_started",
      message: "Started URL ingestion pipeline.",
        data: {
          force: Boolean(options.force),
          crawl4aiPath,
          rawPath,
          chunkPath,
        },
      });

    try {
      const crawlResult = await this.crawl4aiClient.crawlUrl(url, { trace });
      const { rawDoc, crawl4aiResponse } = crawlResult;
      const previousRawDoc = await readOptionalJson(rawPath);
      const unchanged =
        previousRawDoc && previousRawDoc.contentHash === rawDoc.contentHash;

      await writeJson(crawl4aiPath, crawl4aiResponse);
      await trace.recordStep({
        stage: "crawl4ai_response_saved",
        status: "success",
        message: "Saved the original Crawl4AI response payload.",
        data: {
          crawl4aiPath,
          taskId: crawl4aiResponse.taskId,
          selectedContentSource: crawl4aiResponse.selectedContent.source,
        },
      });

      await writeJson(rawPath, rawDoc);
      await trace.recordStep({
        stage: "raw_document_saved",
        status: "success",
        message: "Saved extracted raw document.",
        data: {
          rawPath,
          title: rawDoc.title,
          textLength: rawDoc.cleanedText.length,
          contentHash: rawDoc.contentHash,
          fetchedAt: rawDoc.fetchedAt,
        },
      });

      if (unchanged && !options.force) {
        await trace.recordStep({
          stage: "content_hash_check",
          status: "success",
          message: "Skipped ingestion because the raw document hash did not change.",
          data: {
            rawPath,
            contentHash: rawDoc.contentHash,
          },
        });

        const result = {
          url,
          status: "skipped",
          reason: "content_hash_unchanged",
          crawl4aiPath,
          rawPath,
          tracePath: trace.tracePath,
        };

        await trace.complete(result);
        return result;
      }

      await trace.recordStep({
        stage: "chunking_started",
        message: "Normalizing and chunking the raw document for vector retrieval.",
        data: {
          targetChars: this.config.chunking.targetChars,
          overlapChars: this.config.chunking.overlapChars,
        },
      });

      const vectorArtifacts = buildVectorArtifacts(rawDoc, this.config.chunking);
      const chunks = vectorArtifacts.chunks;

      if (!chunks.length) {
        throw new Error(`No chunks were produced for ${url}.`);
      }

      const chunkSummary = buildChunkingSummary(chunks);
      await trace.recordStep({
        stage: "chunking_completed",
        status: "success",
        message: "Chunking completed.",
        data: chunkSummary,
      });

      await writeJson(chunkPath, {
        document: vectorArtifacts.document,
        url,
        title: vectorArtifacts.document.title,
        fetchedAt: vectorArtifacts.document.fetchedAt,
        contentHash: vectorArtifacts.document.contentHash,
        chunkCount: chunks.length,
        rowCount: vectorArtifacts.directoryRows?.length || 0,
        recordCount: vectorArtifacts.records?.length || chunks.length,
        chunks,
        directoryRows: vectorArtifacts.directoryRows || [],
      });
      await trace.recordStep({
        stage: "chunks_saved",
        status: "success",
        message: "Saved chunk file to disk.",
        data: {
          chunkPath,
          chunkCount: chunks.length,
        },
      });

      const vectorRecords = (vectorArtifacts.records || chunks).filter(
        (record) => record.retrievalAllowed,
      );

      let vectorDimension = null;

      if (vectorRecords.length && this.openAiService.hasEmbeddingSupport()) {
        const embeddingConfig = this.openAiService.getEmbeddingConfig();
        await trace.recordStep({
          stage: "embedding_started",
          message: "Creating embeddings for vector retrieval chunks.",
          data: {
            model: embeddingConfig.model,
            baseUrl: embeddingConfig.baseUrl,
            inputCount: vectorRecords.length,
          },
        });

        const vectors = await this.openAiService.createEmbeddings(
          vectorRecords.map((record) => record.embeddingText || record.text),
        );
        vectorDimension = vectors[0].length;

        await trace.recordStep({
          stage: "embedding_completed",
          status: "success",
          message: "Embeddings created for vector fallback.",
          data: {
            model: embeddingConfig.model,
            vectorCount: vectors.length,
            vectorDimension,
          },
        });

        const collectionResult = await this.qdrantService.ensureCollection(
          vectorDimension,
        );
        await trace.recordStep({
          stage: "qdrant_collection_ready",
          status: "success",
          message: "Qdrant collection is ready for indexing.",
          data: collectionResult,
        });

        const deleteResult = await this.qdrantService.deleteDocument(
          vectorArtifacts.document.docId,
        );
        await trace.recordStep({
          stage: "qdrant_previous_points_deleted",
          status: "success",
          message: "Deleted any previous vector points for the same document id.",
          data: deleteResult,
        });

        const upsertResult = await this.qdrantService.upsertRecords(
          vectorRecords,
          vectors,
        );
        await trace.recordStep({
          stage: "qdrant_upsert_completed",
          status: "success",
          message: "Upserted retrieval chunks into Qdrant.",
          data: upsertResult,
        });
      } else {
        await trace.recordStep({
          stage: "embedding_skipped",
          status: "success",
          message:
            "Skipped vector indexing because no retrievable chunks were produced or embeddings are unavailable.",
          data: {
            eligibleChunkCount: vectorRecords.length,
            embeddingSupport: this.openAiService.hasEmbeddingSupport(),
          },
        });
      }

      const result = {
        url,
        status: "ingested",
        crawl4aiPath,
        rawPath,
        chunkPath,
        tracePath: trace.tracePath,
        chunkCount: chunks.length,
        sourceType: vectorArtifacts.document.sourceType,
      };

      await trace.complete({
        ...result,
        vectorDimension,
        qdrantCollection: this.config.qdrantCollection,
      });

      return result;
    } catch (error) {
      await trace.fail(error, {
        crawl4aiPath,
        rawPath,
        chunkPath,
      });
      error.tracePath = trace.tracePath;
      throw error;
    }
  }

  async ingestUrls(urls, options = {}) {
    const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
    const results = await mapWithConcurrency(
      uniqueUrls,
      this.config.ingestConcurrency,
      async (url) => {
        try {
          return await this.ingestUrl(url, options);
        } catch (error) {
          return {
            url,
            status: "failed",
            error: error.message,
            tracePath: error.tracePath || null,
          };
        }
      },
    );

    return {
      total: uniqueUrls.length,
      ingested: results.filter((item) => item.status === "ingested").length,
      skipped: results.filter((item) => item.status === "skipped").length,
      failed: results.filter((item) => item.status === "failed").length,
      results,
    };
  }
}

  return { IngestionService };
})();
async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!response.ok) {
    const message =
      data?.status?.error ||
      data?.message ||
      data?.error ||
      `HTTP ${response.status} for ${url}`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function getJson(url, headers = {}) {
  return requestJson(url, { method: "GET", headers });
}

async function postJson(url, body, headers = {}) {
  return requestJson(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function putJson(url, body, headers = {}) {
  return requestJson(url, { method: "PUT", headers, body: JSON.stringify(body) });
}

globalThis.__indexingInternals.requestJson = requestJson;
globalThis.__indexingInternals.getJson = getJson;
globalThis.__indexingInternals.postJson = postJson;
globalThis.__indexingInternals.putJson = putJson;
export const { config } = __configModule;
export const { sleep, mapWithConcurrency } = __asyncModule;
export const { sha256, hashToUuid } = __hashModule;
export const { getDomain, fileStemForUrl } = __urlModule;
export const { ensureDir, readJson, writeJson, readLinesFile } = __filesModule;
export const { extractTitleFromMarkdown, chunkDocument } = __chunkerModule;
export const { IngestionTrace, buildChunkingSummary, createIngestionTrace } = __ingestionTraceModule;
export const { deriveAirlineName, normalizeDocument, buildSections, extractBaggageFacts, extractBaggageDirectoryRows, extractAirlineRegistry, buildHybridArtifacts } = __hybridDocumentsModule;
export const { buildVectorArtifacts } = __vectorDocumentsModule;
export const { firstDefined, pickResultPayload, extractCleanedText, buildRawDocFromCrawlResult } = __crawl4aiResultModule;
export const { OpenAIService } = __openAiServiceModule;
export const { buildPayloadFilter, QdrantService } = __qdrantServiceModule;
export const { RunImportService } = __runImportServiceModule;
export const { IngestionService } = __ingestionServiceModule;
