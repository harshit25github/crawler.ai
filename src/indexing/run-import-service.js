import { join } from "node:path";
import { mapWithConcurrency } from "./async.js";
import { buildRawDocFromCrawlResult, pickResultPayload } from "./crawl4ai-result.js";
import { readJson, writeJson } from "./files.js";
import { buildVectorArtifacts } from "./vector-documents.js";
import { fileStemForUrl } from "./url.js";

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

export { RunImportService };
