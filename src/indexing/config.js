import "dotenv/config";
import process from "node:process";
import { resolve } from "node:path";

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
  openAiChatModel: readString("OPENAI_CHAT_MODEL", "gpt-5.1"),
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

export { config };
