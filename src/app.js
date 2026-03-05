import Fastify from "fastify";
import { resolve } from "node:path";
import { createServices } from "./bootstrap.js";
import { readLinesFile } from "./lib/files.js";

export function buildApp() {
  const app = Fastify({ logger: false });
  const services = createServices();

  app.get("/health", async () => ({
    status: "ok",
    collection: services.config.qdrantCollection,
  }));

  app.post("/api/ingest", async (request, reply) => {
    const body = request.body || {};
    let urls = body.urls;

    if ((!urls || !urls.length) && body.urlsFile) {
      urls = await readLinesFile(
        resolve(services.config.paths.rootDir, body.urlsFile),
      );
    }

    if (!Array.isArray(urls) || !urls.length) {
      reply.code(400);
      return { error: "Pass urls[] or urlsFile." };
    }

    return services.ingestionService.ingestUrls(urls, {
      force: Boolean(body.force),
    });
  });

  app.post("/api/retrieve", async (request, reply) => {
    const body = request.body || {};

    if (!body.query?.trim()) {
      reply.code(400);
      return { error: "query is required." };
    }

    const results = await services.retrievalService.retrieve(body.query, {
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

    return services.agentService.answerQuery({
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
