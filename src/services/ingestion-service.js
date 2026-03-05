import { join } from "node:path";
import { mapWithConcurrency } from "../lib/async.js";
import { readJson, writeJson } from "../lib/files.js";
import { chunkDocument } from "../lib/chunker.js";
import { fileStemForUrl } from "../lib/url.js";
import {
  buildChunkingSummary,
  createIngestionTrace,
} from "../lib/ingestion-trace.js";

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

export class IngestionService {
  constructor({ config, crawl4aiClient, openAiService, qdrantService }) {
    this.config = config;
    this.crawl4aiClient = crawl4aiClient;
    this.openAiService = openAiService;
    this.qdrantService = qdrantService;
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
        message: "Chunking the raw document for retrieval.",
        data: {
          targetChars: this.config.chunking.targetChars,
          overlapChars: this.config.chunking.overlapChars,
        },
      });

      const chunks = chunkDocument(rawDoc, this.config.chunking);

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
        url,
        title: rawDoc.title,
        fetchedAt: rawDoc.fetchedAt,
        contentHash: rawDoc.contentHash,
        chunkCount: chunks.length,
        chunks,
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

      const embeddingConfig = this.openAiService.getEmbeddingConfig();
      await trace.recordStep({
        stage: "embedding_started",
        message: "Creating embeddings for chunks.",
        data: {
          model: embeddingConfig.model,
          baseUrl: embeddingConfig.baseUrl,
          inputCount: chunks.length,
        },
      });

      const vectors = await this.openAiService.createEmbeddings(
        chunks.map((chunk) => chunk.text),
      );

      await trace.recordStep({
        stage: "embedding_completed",
        status: "success",
        message: "Embeddings created.",
        data: {
          model: embeddingConfig.model,
          vectorCount: vectors.length,
          vectorDimension: vectors[0].length,
        },
      });

      const collectionResult = await this.qdrantService.ensureCollection(
        vectors[0].length,
      );
      await trace.recordStep({
        stage: "qdrant_collection_ready",
        status: "success",
        message: "Qdrant collection is ready for indexing.",
        data: collectionResult,
      });

      const deleteResult = await this.qdrantService.deleteDocument(rawDoc.docId);
      await trace.recordStep({
        stage: "qdrant_previous_points_deleted",
        status: "success",
        message: "Deleted any previous points for the same document id.",
        data: deleteResult,
      });

      const upsertResult = await this.qdrantService.upsertChunks(chunks, vectors);
      await trace.recordStep({
        stage: "qdrant_upsert_completed",
        status: "success",
        message: "Upserted chunk vectors into Qdrant.",
        data: upsertResult,
      });

      const result = {
        url,
        status: "ingested",
        crawl4aiPath,
        rawPath,
        chunkPath,
        tracePath: trace.tracePath,
        chunkCount: chunks.length,
      };

      await trace.complete({
        ...result,
        vectorDimension: vectors[0].length,
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
