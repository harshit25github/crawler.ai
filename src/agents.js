import Fastify from "fastify";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import { Agent, run, setDefaultOpenAIClient } from "@openai/agents";
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

  function buildAgentPrompt({ query, chunks, history = [] }) {
    const formattedHistory = sanitizeHistory(history)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n");
    const formattedContext = chunks
      .map((chunk) => {
        const section = chunk.sectionPath?.length
          ? chunk.sectionPath.join(" > ")
          : "General";

        return [
          `[${chunk.citationIndex}]`,
          `URL: ${chunk.url}`,
          `Title: ${chunk.title}`,
          `Source Type: ${chunk.sourceType || "unknown"}`,
          `Airline: ${chunk.airlineName || "n/a"}`,
          `Route Scope: ${chunk.routeScope || "n/a"}`,
          `Section: ${section}`,
          `Chunk: ${chunk.chunkIndex ?? chunk.sectionIndex ?? 0}`,
          `Text: ${chunk.text}`,
        ].join("\n");
      })
      .join("\n\n");

    return [
      formattedHistory ? `Conversation history:\n${formattedHistory}` : null,
      "Retrieved context:",
      formattedContext,
      "",
      `Question: ${query}`,
      "Answer only from the retrieved context. If the context is insufficient, say so. Cite every material claim with chunk markers like [1] or [2].",
    ]
      .filter(Boolean)
      .join("\n");
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

  async function answerQuery({ query, topK, filter, history = [] }) {
    const chunks = await retrievalService.retrieve(query, {
      topK,
      filter,
    });

    if (!chunks.length) {
      return {
        answer: "I could not find relevant chunks in the indexed URL knowledge base.",
        citations: [],
        chunks: [],
      };
    }

    if (!config.openAiApiKey) {
      throw new Error("OPENAI_API_KEY is required for agent answers.");
    }

    if (!openAiClient) {
      openAiClient = new OpenAI({
        apiKey: config.openAiApiKey,
        baseURL: config.openAiBaseUrl,
      });
      setDefaultOpenAIClient(openAiClient);
    }

    const agent = new Agent({
      name: "URL Knowledge Base Agent",
      model: config.openAiChatModel,
      instructions:
        "You answer only from the supplied retrieved context. Never invent facts or sources. Every material claim must include one or more chunk citations like [1] or [2].",
    });
    const result = await run(
      agent,
      buildAgentPrompt({
        query,
        chunks,
        history,
      }),
      { maxTurns: 2 },
    );
    const answer = String(result.finalOutput || "").trim();

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
