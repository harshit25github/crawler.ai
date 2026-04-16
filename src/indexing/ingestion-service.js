import { join } from "node:path";
import { mapWithConcurrency } from "./async.js";
import { readJson, writeJson } from "./files.js";
import { buildVectorArtifacts } from "./vector-documents.js";
import { fileStemForUrl } from "./url.js";
import { buildChunkingSummary, createIngestionTrace } from "./ingestion-trace.js";

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
    const onProgress =
      typeof options.onProgress === "function" ? options.onProgress : null;
    const results = await mapWithConcurrency(
      uniqueUrls,
      this.config.ingestConcurrency,
      async (url) => {
        let result;

        try {
          onProgress?.({
            event: "url_started",
            url,
          });
          result = await this.ingestUrl(url, options);
          return result;
        } catch (error) {
          result = {
            url,
            status: "failed",
            error: error.message,
            tracePath: error.tracePath || null,
          };
          return result;
        } finally {
          if (result) {
            onProgress?.({
              event: "url_completed",
              url,
              result,
            });
          }
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

export { IngestionService };
