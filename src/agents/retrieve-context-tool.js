import { tool } from "@openai/agents";
import { appendRetrievalToolLogEntry } from "./interaction-logger.js";

export const MAX_AGENT_TOOL_TOP_K = 8;
export const RETRIEVE_CONTEXT_TOOL_NAME = "retrieve_context";

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

function summarizeTraceToolResultChunk(chunk) {
  return {
    citationIndex: chunk.citationIndex,
    sourceType: chunk.sourceType || null,
    title: chunk.title || null,
    sectionTitle: chunk.sectionTitle || null,
    airlineName: chunk.airlineName || null,
    routeScope: chunk.routeScope || null,
    url: chunk.url || null,
    score: chunk.score ?? null,
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

export function createRetrieveContextExecutor({
  retrievalService,
  citationRegistry,
  baseTopK,
  baseFilter,
  defaultTopK,
  config,
  traceId = null,
  toolTraceCollector = null,
}) {
  return async (input = {}) => {
    const toolInput =
      input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const query = String(toolInput.query || "").trim();
    const toolCallIndex = Array.isArray(toolTraceCollector)
      ? toolTraceCollector.length + 1
      : 1;
    const retrievalTrace = [
      {
        at: new Date().toISOString(),
        stage: "tool_input_received",
        query,
        toolInput,
      },
    ];

    if (!query) {
      throw new Error("retrieve_context requires a non-empty query.");
    }

    const appliedTopK = resolveToolTopK({
      baseTopK,
      toolTopK: toolInput.topK,
      defaultTopK,
    });
    const appliedFilter = mergeRequestFilter(baseFilter, toolInput.filter || {});
    retrievalTrace.push({
      at: new Date().toISOString(),
      stage: "tool_input_resolved",
      appliedTopK,
      appliedFilter,
    });

    try {
      const results = await retrievalService.retrieve(query, {
        topK: appliedTopK,
        filter: appliedFilter,
        trace: retrievalTrace,
      });
      const registeredResults = citationRegistry.register(results);
      const payload = {
        query,
        appliedTopK,
        appliedFilter,
        resultCount: registeredResults.length,
        results: registeredResults.map(formatToolResultChunk),
      };
      const entry = {
        timestamp: new Date().toISOString(),
        traceId,
        toolCallIndex,
        query,
        toolInput,
        appliedTopK,
        appliedFilter,
        resultCount: registeredResults.length,
        results: registeredResults.map((chunk) =>
          summarizeTraceToolResultChunk(chunk),
        ),
        retrievalTrace,
        error: null,
      };

      if (Array.isArray(toolTraceCollector)) {
        toolTraceCollector.push(entry);
      }
      if (config) {
        await appendRetrievalToolLogEntry(config, entry);
      }

      return payload;
    } catch (error) {
      const entry = {
        timestamp: new Date().toISOString(),
        traceId,
        toolCallIndex,
        query,
        toolInput,
        appliedTopK,
        appliedFilter,
        resultCount: 0,
        results: [],
        retrievalTrace,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
              }
            : {
                name: "Error",
                message: String(error),
              },
      };

      if (Array.isArray(toolTraceCollector)) {
        toolTraceCollector.push(entry);
      }
      if (config) {
        await appendRetrievalToolLogEntry(config, entry);
      }

      throw error;
    }
  };
}

export function createRetrieveContextTool(options) {
  const execute = createRetrieveContextExecutor(options);

  return tool({
    name: RETRIEVE_CONTEXT_TOOL_NAME,
    description: [
      "Retrieve grounded KB context before answering.",
      "The end user only provides natural language; infer any retrieval constraints yourself.",
      "For baggage questions, pass a concise query that preserves airline, origin, destination, cabin/class, fare brand, and requested baggage facets.",
      "For broad baggage-policy questions, do not over-filter to a single facet; let the retrieval service find directory rows plus linked official policy chunks.",
      "Use filter.sourceType only when the user clearly asks about a specific document family such as privacy_policy, cookie_policy, terms_conditions, service_fees, post_ticketing_fees, baggage_directory_row, or airline_policy.",
      "Use filter.airline or filter.facet only when the user explicitly names an airline or asks for a specific facet, and only to narrow retrieval.",
      "Never invent filters that exclude likely relevant evidence.",
    ].join(" "),
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "A concise natural-language retrieval query derived from the user question. Preserve airline, origin, destination, cabin/class, fare brand, baggage facet, policy family, and named source/site when present.",
        },
        topK: {
          type: "integer",
          minimum: 1,
          maximum: MAX_AGENT_TOOL_TOP_K,
          description:
            "Optional chunk count. Omit unless follow-up retrieval needs broader or narrower evidence.",
        },
        filter: {
          type: "object",
          additionalProperties: false,
          description:
            "Optional inferred retrieval constraints. The user does not send these directly; use only when the natural-language question clearly implies them.",
          properties: {
            domain: {
              type: "string",
              description:
                "Optional domain constraint, for example www.cheapoair.com. Avoid unless the question explicitly names a source/site.",
            },
            url: {
              type: "string",
              description:
                "Optional exact URL constraint. Use only if a previous retrieved row gives a policy URL or the user explicitly gives a URL.",
            },
            sourceType: {
              type: "string",
              description:
                "Optional source family such as privacy_policy, cookie_policy, terms_conditions, service_fees, post_ticketing_fees, baggage_directory_row, or airline_policy. Omit for broad baggage-policy questions unless a specific source family is clearly needed.",
            },
            airline: {
              type: "string",
              description:
                "Optional airline name when explicitly stated by the user.",
            },
            facet: {
              type: "string",
              description:
                "Optional baggage facet such as carry_on, first_checked_bag, second_checked_bag, oversize, overweight, special_items, or additional_policy.",
            },
          },
        },
      },
      required: ["query"],
    },
    execute,
  });
}
