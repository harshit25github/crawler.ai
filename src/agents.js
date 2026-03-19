import Fastify from "fastify";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import {
  Agent,
  run,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  tool,
} from "@openai/agents";
import {
  config as baseConfig,
  IngestionService,
  OpenAIService,
  QdrantService,
  readLinesFile,
  RunImportService,
} from "./indexing.js";
import { Crawl4AIClient } from "./crawler.js";
import { RetrievalService } from "./retrivel.js";

const MAX_AGENT_TOOL_TOP_K = 8;
const RETRIEVE_CONTEXT_TOOL_NAME = "retrieve_context";

function sanitizeTopK(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function sanitizeFilter(filter = {}) {
  return Object.fromEntries(
    Object.entries(filter || {}).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
}

function mergeRequestFilter(baseFilter = {}, toolFilter = {}) {
  return sanitizeFilter({
    ...sanitizeFilter(toolFilter),
    ...sanitizeFilter(baseFilter),
  });
}

function resolveToolTopK({ baseTopK, toolTopK, defaultTopK }) {
  const normalizedBaseTopK = sanitizeTopK(baseTopK);
  const normalizedToolTopK = sanitizeTopK(toolTopK);
  let resolvedTopK = normalizedToolTopK ?? normalizedBaseTopK ?? defaultTopK ?? 6;

  if (normalizedBaseTopK) {
    resolvedTopK = Math.min(resolvedTopK, normalizedBaseTopK);
  }

  return Math.max(1, Math.min(resolvedTopK, MAX_AGENT_TOOL_TOP_K));
}

function chunkRegistryKey(chunk) {
  return (
    chunk.rowId ||
    chunk.sectionId ||
    chunk.id ||
    [
      chunk.url || "",
      chunk.sectionTitle || "",
      Array.isArray(chunk.sectionPath) ? chunk.sectionPath.join(">") : "",
      chunk.chunkIndex ?? chunk.sectionIndex ?? "",
    ].join("|")
  );
}

function mergeChunkRecord(existing, incoming) {
  const merged = { ...existing };

  for (const [key, value] of Object.entries(incoming || {})) {
    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  }

  merged.citationIndex = existing.citationIndex;
  return merged;
}

function buildCitations(chunks) {
  return chunks.map((chunk) => ({
    citationIndex: chunk.citationIndex,
    url: chunk.url,
    title: chunk.title,
    sectionPath: chunk.sectionPath,
    chunkIndex: chunk.chunkIndex ?? chunk.sectionIndex ?? 0,
    score: chunk.score,
  }));
}

export function createCitationRegistry() {
  const entries = new Map();
  let nextCitationIndex = 1;

  function register(chunks = []) {
    return chunks.map((chunk) => {
      const key = chunkRegistryKey(chunk);
      const existing = entries.get(key);

      if (existing) {
        const merged = mergeChunkRecord(existing, chunk);
        entries.set(key, merged);
        return { ...merged };
      }

      const created = {
        ...chunk,
        citationIndex: nextCitationIndex,
      };
      nextCitationIndex += 1;
      entries.set(key, created);
      return { ...created };
    });
  }

  function getChunks() {
    return [...entries.values()]
      .sort((left, right) => left.citationIndex - right.citationIndex)
      .map((chunk) => ({ ...chunk }));
  }

  function getCitations() {
    return buildCitations(getChunks());
  }

  return {
    register,
    getChunks,
    getCitations,
  };
}

function formatToolResultChunk(chunk) {
  return {
    citationIndex: chunk.citationIndex,
    url: chunk.url,
    title: chunk.title,
    sourceType: chunk.sourceType,
    airlineName: chunk.airlineName || null,
    routeScope: chunk.routeScope || null,
    sectionTitle: chunk.sectionTitle || null,
    sectionPath: chunk.sectionPath || [],
    text: chunk.text,
    score: chunk.score,
  };
}

export function createRetrieveContextExecutor({
  retrievalService,
  citationRegistry,
  baseTopK,
  baseFilter,
  defaultTopK,
}) {
  return async (input = {}) => {
    const toolInput =
      input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const query = String(toolInput.query || "").trim();

    if (!query) {
      throw new Error("retrieve_context requires a non-empty query.");
    }

    const appliedTopK = resolveToolTopK({
      baseTopK,
      toolTopK: toolInput.topK,
      defaultTopK,
    });
    const appliedFilter = mergeRequestFilter(baseFilter, toolInput.filter || {});
    const results = await retrievalService.retrieve(query, {
      topK: appliedTopK,
      filter: appliedFilter,
    });
    const registeredResults = citationRegistry.register(results);

    return {
      query,
      appliedTopK,
      appliedFilter,
      resultCount: registeredResults.length,
      results: registeredResults.map(formatToolResultChunk),
    };
  };
}

export function createRetrieveContextTool(options) {
  const execute = createRetrieveContextExecutor(options);

  return tool({
    name: RETRIEVE_CONTEXT_TOOL_NAME,
    description:
      "Retrieve grounded knowledge base context for the user's question. Use this before answering, and call it again if you need narrower or follow-up evidence.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "The retrieval query to run against the indexed knowledge base.",
        },
        topK: {
          type: "integer",
          minimum: 1,
          maximum: MAX_AGENT_TOOL_TOP_K,
          description: "Optional number of chunks to retrieve.",
        },
        filter: {
          type: "object",
          additionalProperties: false,
          properties: {
            domain: { type: "string" },
            url: { type: "string" },
            sourceType: { type: "string" },
            airline: { type: "string" },
            facet: { type: "string" },
          },
        },
      },
      required: ["query"],
    },
    execute,
  });
}

function buildAgentConversationInput({ query, history = [] }) {
  const formattedHistory = history
    .filter(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim(),
    )
    .slice(-8)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");

  return [
    formattedHistory ? `Conversation history:\n${formattedHistory}` : null,
    `Current user question:\n${String(query || "").trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createChatAgent({ config, retrieveContextTool }) {
  return new Agent({
    name: "URL Knowledge Base Agent",
    model: config.openAiChatModel,
    instructions: `You are a grounded URL knowledge base assistant.
Always call ${RETRIEVE_CONTEXT_TOOL_NAME} before answering a user question about the indexed knowledge base.
You may call ${RETRIEVE_CONTEXT_TOOL_NAME} multiple times if the first retrieval is incomplete or needs narrower filters.
Answer only from retrieved tool output.
If the retrieved tool output is insufficient, say that the indexed knowledge base does not contain enough verified context.
Every material claim must include one or more citations like [1] or [2].`,
    tools: [retrieveContextTool],
    modelSettings: {
      toolChoice: "required",
      parallelToolCalls: false,
    },
    resetToolChoice: true,
    toolUseBehavior: "run_llm_again",
  });
}

export function createKbSystem(configOverride = {}) {
  const config = {
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
  let openAiClient = null;

  function sanitizeHistory(history = []) {
    return history
      .filter(
        (message) =>
          message &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string" &&
          message.content.trim(),
      )
      .slice(-8);
  }

  async function answerQuery({ query, topK, filter, history = [] }) {
    if (!config.openAiApiKey) {
      throw new Error("OPENAI_API_KEY is required for agent answers.");
    }

    if (!openAiClient) {
      openAiClient = new OpenAI({
        apiKey: config.openAiApiKey,
        baseURL: config.openAiBaseUrl,
      });
      setOpenAIAPI("chat_completions");
      setDefaultOpenAIClient(openAiClient);
    }

    const citationRegistry = createCitationRegistry();
    const retrieveContextTool = createRetrieveContextTool({
      retrievalService,
      citationRegistry,
      baseTopK: topK,
      baseFilter: filter,
      defaultTopK: config.defaultTopK,
    });
    const agent = createChatAgent({
      config,
      retrieveContextTool,
    });
    const result = await run(
      agent,
      buildAgentConversationInput({
        query,
        history: sanitizeHistory(history),
      }),
      { maxTurns: 6 },
    );
    const answer = String(result.finalOutput || "").trim();
    const chunks = citationRegistry.getChunks();

    if (!chunks.length) {
      return {
        answer: "I could not find relevant chunks in the indexed URL knowledge base.",
        citations: [],
        chunks: [],
      };
    }

    return {
      answer:
        answer || "I could not generate a grounded answer from the retrieved context.",
      citations: buildCitations(chunks),
      chunks,
    };
  }

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

export function buildApp() {
  const app = Fastify({ logger: false });
  const kb = createKbSystem();

  app.get("/health", async () => ({
    status: "ok",
    collection: kb.config.qdrantCollection,
  }));

  app.post("/api/ingest", async (request, reply) => {
    const body = request.body || {};
    if (body.runDir) {
      return kb.ingestRunDirectory(resolve(kb.config.paths.rootDir, body.runDir));
    }

    let urls = body.urls;

    if ((!urls || !urls.length) && body.urlsFile) {
      urls = await readLinesFile(resolve(kb.config.paths.rootDir, body.urlsFile));
    }

    if (!Array.isArray(urls) || !urls.length) {
      reply.code(400);
      return { error: "Pass urls[] or urlsFile." };
    }

    return kb.ingestUrls(urls, {
      force: Boolean(body.force),
    });
  });

  app.post("/api/retrieve", async (request, reply) => {
    const body = request.body || {};

    if (!body.query?.trim()) {
      reply.code(400);
      return { error: "query is required." };
    }

    const results = await kb.retrieve(body.query, {
      topK: body.topK,
      filter: body.filter,
    });

    return {
      query: body.query,
      results,
    };
  });

  app.post("/api/chat", async (request, reply) => {
    const body = request.body || {};

    if (!body.query?.trim()) {
      reply.code(400);
      return { error: "query is required." };
    }

    return kb.answerQuery({
      query: body.query,
      topK: body.topK,
      filter: body.filter,
      history: body.history || [],
    });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    reply.code(error.statusCode || 500).send({
      error: error.message,
    });
  });

  return app;
}

function printUsage() {
  console.log(`Usage:
  node src/agents.js server
  node src/agents.js ingest <urlsFileOrUrl> [--force]
  node src/agents.js ingest-run <runDir>
  node src/agents.js retrieve "<query>" [--topK=6] [--domain=example.com] [--url=https://...] [--sourceType=privacy_policy] [--airline=Delta]
  node src/agents.js chat "<query>" [--topK=6] [--domain=example.com] [--url=https://...] [--sourceType=privacy_policy] [--airline=Delta]`);
}

function parseFlags(args) {
  const flags = {};

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, value] = arg.slice(2).split("=");
    flags[key] = value ?? true;
  }

  return flags;
}

async function runCli(command, rest) {
  const kb = createKbSystem();
  const flags = parseFlags(rest);
  const positional = rest.filter((arg) => !arg.startsWith("--"));

  if (command === "ingest") {
    const input = positional[0];

    if (!input) {
      throw new Error("Provide a URL or a file path.");
    }

    const urls = input.startsWith("http")
      ? [input]
      : await readLinesFile(resolve(kb.config.paths.rootDir, input));

    const result = await kb.ingestUrls(urls, {
      force: Boolean(flags.force),
    });

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "retrieve") {
    const query = positional.join(" ").trim();

    if (!query) {
      throw new Error("Provide a retrieval query.");
    }

    const results = await kb.retrieve(query, {
      topK: flags.topK ? Number(flags.topK) : undefined,
      filter: {
        domain: flags.domain,
        url: flags.url,
        sourceType: flags.sourceType,
        airline: flags.airline,
        facet: flags.facet,
      },
    });

    console.log(JSON.stringify({ query, results }, null, 2));
    return;
  }

  if (command === "chat") {
    const query = positional.join(" ").trim();

    if (!query) {
      throw new Error("Provide a chat query.");
    }

    const result = await kb.answerQuery({
      query,
      topK: flags.topK ? Number(flags.topK) : undefined,
      filter: {
        domain: flags.domain,
        url: flags.url,
        sourceType: flags.sourceType,
        airline: flags.airline,
        facet: flags.facet,
      },
    });

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "ingest-run") {
    const input = positional[0];

    if (!input) {
      throw new Error("Provide a crawl run directory.");
    }

    const result = await kb.ingestRunDirectory(resolve(kb.config.paths.rootDir, input));

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printUsage();
  process.exit(1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    printUsage();
    process.exit(1);
  }

  if (command === "server") {
    const app = buildApp();
    await app.listen({ port: baseConfig.port, host: "0.0.0.0" });
    return;
  }

  await runCli(command, rest);
}

const isDirectRun =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main()
    .then(() => {
      if (process.argv[2] !== "server") {
        process.exit(0);
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
