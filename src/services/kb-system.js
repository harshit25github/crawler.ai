import {
  config as baseConfig,
  IngestionService,
  OpenAIService,
  QdrantService,
  RunImportService,
} from "../indexing/index.js";
import { Crawl4AIClient } from "../crawler/index.js";
import { RetrievalService } from "../retrieval/index.js";
import { createAnswerQuery } from "../agents/kb-chat-service.js";

export function buildKbConfig(configOverride = {}) {
  return {
    ...baseConfig,
    ...configOverride,
    chunking: {
      ...baseConfig.chunking,
      ...(configOverride.chunking || {}),
    },
    paths: {
      ...baseConfig.paths,
      ...(configOverride.paths || {}),
    },
  };
}

export function createKbSystem(configOverride = {}) {
  const config = buildKbConfig(configOverride);
  const crawl4aiClient = new Crawl4AIClient(config);
  const openAiService = new OpenAIService(config);
  const qdrantService = new QdrantService(config);
  const runImportService = new RunImportService({
    config,
    openAiService,
    qdrantService,
  });
  const ingestionService = new IngestionService({
    config,
    crawl4aiClient,
    openAiService,
    qdrantService,
    runImportService,
  });
  const retrievalService = new RetrievalService({
    config,
    openAiService,
    qdrantService,
  });
  const answerQuery = createAnswerQuery({
    config,
    retrievalService,
  });

  return {
    config,
    crawl4aiClient,
    openAiService,
    qdrantService,
    runImportService,
    ingestionService,
    retrievalService,
    ingestUrl: ingestionService.ingestUrl.bind(ingestionService),
    ingestUrls: ingestionService.ingestUrls.bind(ingestionService),
    ingestRunDirectory: ingestionService.ingestRunDirectory.bind(ingestionService),
    retrieve: retrievalService.retrieve.bind(retrievalService),
    answerQuery,
  };
}
