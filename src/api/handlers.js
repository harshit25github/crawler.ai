import { logChatWorkflowStep } from "../agents/interaction-logger.js";
import { openApiSpec, renderSwaggerHtml } from "./openapi.js";
import { normalizeQuery, sendBadRequest } from "./request-utils.js";

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildBaggagePolicyQuery(payload = {}) {
  const origin = normalizeText(payload.origin);
  const destination = normalizeText(payload.destination);
  const airline = normalizeText(payload.airline);
  const cabin = normalizeText(payload.cabin);
  const brandName = normalizeText(payload.brandName || payload.brand);
  const errors = [];

  if (!origin) {
    errors.push("origin is required.");
  }
  if (!destination) {
    errors.push("destination is required.");
  }
  if (!airline) {
    errors.push("airline is required.");
  }
  if (!cabin) {
    errors.push("cabin is required.");
  }

  if (errors.length) {
    return {
      errors,
      query: null,
      normalizedInput: {
        origin: origin || null,
        destination: destination || null,
        airline: airline || null,
        cabin: cabin || null,
        brandName: brandName || null,
      },
    };
  }

  const brandClause = brandName ? ` with ${brandName} brand` : "";

  return {
    errors: [],
    query: `I have a flight from ${origin} to ${destination} on ${airline} in ${cabin} class${brandClause}, What will be the baggage policy`,
    normalizedInput: {
      origin,
      destination,
      airline,
      cabin,
      brandName: brandName || null,
    },
  };
}

export function createApiHandlers(kb, { ingestJobManager } = {}) {
  return {
    health(request, response) {
      response.json({
        status: "ok",
        collection: kb.config.qdrantCollection,
      });
    },

    openApiJson(request, response) {
      response.json(openApiSpec);
    },

    swaggerUi(request, response) {
      response.type("html").send(renderSwaggerHtml());
    },

    async ingest(request, response) {
      if (!ingestJobManager) {
        throw new Error("Ingest job manager is not configured.");
      }

      let job;
      try {
        job = await ingestJobManager.createJob(request.body || {});
      } catch (error) {
        if (error.statusCode === 400) {
          sendBadRequest(response, error.message);
          return;
        }

        throw error;
      }

      response.status(202).json({
        jobId: job.jobId,
        status: job.status,
        statusUrl: `/api/ingest/jobs/${job.jobId}`,
      });
    },

    listIngestJobs(request, response) {
      if (!ingestJobManager) {
        throw new Error("Ingest job manager is not configured.");
      }

      response.json({
        jobs: ingestJobManager.listJobs(),
      });
    },

    getIngestJob(request, response) {
      if (!ingestJobManager) {
        throw new Error("Ingest job manager is not configured.");
      }

      const job = ingestJobManager.getJob(request.params.jobId);
      if (!job) {
        response.status(404).json({
          error: "Ingest job not found.",
        });
        return;
      }

      response.json(job);
    },

    async retrieve(request, response) {
      const body = request.body || {};
      const query = normalizeQuery(body.query);

      if (!query) {
        sendBadRequest(response, "query is required.");
        return;
      }

      const results = await kb.retrieve(query, {
        topK: body.topK,
        filter: body.filter,
      });

      response.json({
        query,
        results,
      });
    },

    async chat(request, response) {
      const body = request.body || {};
      const query = normalizeQuery(body.query);
      const bodyKeys = Object.keys(body);

      await logChatWorkflowStep({
        config: kb.config,
        stage: "api_chat_request_received",
        query,
        data: {
          method: request.method,
          path: request.path,
          bodyKeys,
          ignoredBodyKeys: bodyKeys.filter((key) => key !== "query"),
          queryLength: query.length,
        },
      });

      if (!query) {
        sendBadRequest(response, "query is required.");
        return;
      }

      // Public chat is intentionally natural-language only. Filters are inferred
      // by the agent/tool instructions instead of being accepted from callers.
      const debugContext = {};
      const result = await kb.answerQuery({ query, debugContext });
      await logChatWorkflowStep({
        config: kb.config,
        traceId: debugContext.traceId,
        stage: "api_chat_response_ready",
        query,
        data: {
          answerLength: result.answer?.length || 0,
          answerPreview: result.answer?.slice(0, 240) || null,
          citationCount: result.citations?.length || 0,
          chunkCount: result.chunks?.length || 0,
          toolCallCount: debugContext.toolCalls?.length || 0,
        },
      });
      response.json(result);
    },

    async baggageChat(request, response) {
      const body = request.body || {};
      const { query, normalizedInput, errors } = buildBaggagePolicyQuery(body);

      await logChatWorkflowStep({
        config: kb.config,
        stage: "api_baggage_chat_request_received",
        query: query || "",
        data: {
          method: request.method,
          path: request.path,
          bodyKeys: Object.keys(body),
          normalizedInput,
          validationErrors: errors,
        },
      });

      if (errors.length) {
        response.status(400).json({
          error: "Invalid baggage chat payload.",
          errors,
        });
        return;
      }

      const debugContext = {};
      const result = await kb.answerQuery({
        query,
        debugContext,
        requestSource: "api_baggage_chat",
      });

      await logChatWorkflowStep({
        config: kb.config,
        traceId: debugContext.traceId,
        stage: "api_baggage_chat_response_ready",
        query,
        data: {
          generatedQuery: query,
          normalizedInput,
          answerLength: result.answer?.length || 0,
          answerPreview: result.answer?.slice(0, 240) || null,
          citationCount: result.citations?.length || 0,
          chunkCount: result.chunks?.length || 0,
          toolCallCount: debugContext.toolCalls?.length || 0,
        },
      });

      response.json({
        generatedQuery: query,
        normalizedInput,
        ...result,
      });
    },
  };
}
