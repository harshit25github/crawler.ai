import { config } from "./config.js";
import { Crawl4AIClient } from "./services/crawl4ai-client.js";
import { OpenAIService } from "./services/openai-service.js";
import { QdrantService } from "./services/qdrant-service.js";
import { IngestionService } from "./services/ingestion-service.js";
import { RetrievalService } from "./services/retrieval-service.js";
import { AgentService } from "./services/agent-service.js";
import { createRetrieveChunksTool } from "./agent/tools/retrieve-chunks-tool.js";

export function createServices() {
  const crawl4aiClient = new Crawl4AIClient(config);
  const openAiService = new OpenAIService(config);
  const qdrantService = new QdrantService(config);
  const ingestionService = new IngestionService({
    config,
    crawl4aiClient,
    openAiService,
    qdrantService,
  });
  const retrievalService = new RetrievalService({
    config,
    openAiService,
    qdrantService,
  });
  const retrieveChunksTool = createRetrieveChunksTool(retrievalService);
  const agentService = new AgentService({
    openAiService,
    retrieveChunksTool,
  });

  return {
    config,
    crawl4aiClient,
    openAiService,
    qdrantService,
    ingestionService,
    retrievalService,
    retrieveChunksTool,
    agentService,
  };
}
