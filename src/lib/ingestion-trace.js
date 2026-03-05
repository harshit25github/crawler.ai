import { join } from "node:path";
import { hashToUuid } from "./hash.js";
import { fileStemForUrl } from "./url.js";
import { writeJson } from "./files.js";

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

export class IngestionTrace {
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

export function buildChunkingSummary(chunks) {
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

export function createIngestionTrace({ config, url }) {
  return new IngestionTrace({ config, url });
}
