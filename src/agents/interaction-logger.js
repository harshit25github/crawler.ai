import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const CHAT_LOG_FILENAME = "chat-interactions.jsonl";
const RETRIEVE_CONTEXT_TOOL_LOG_FILENAME = "retrieve-context-tool.jsonl";
const CHAT_WORKFLOW_LOG_FILENAME = "chat-workflow.jsonl";
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|password|secret|token)/iu;

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

function truncateText(value, maxLength = 1000) {
  if (typeof value !== "string" || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function sanitizeLogValue(value, depth = 0) {
  if (depth > 5) {
    return "[max_depth]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, item]) => [
          key,
          SENSITIVE_KEY_PATTERN.test(key)
            ? "[redacted]"
            : sanitizeLogValue(item, depth + 1),
        ]),
    );
  }

  return String(value);
}

async function appendJsonl(config, fileName, entry) {
  const logsDir = join(config.paths.dataDir, "logs");
  const logPath = join(logsDir, fileName);
  await mkdir(logsDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function appendChatLogEntry(config, entry) {
  await appendJsonl(config, CHAT_LOG_FILENAME, entry);
}

export async function appendRetrievalToolLogEntry(config, entry) {
  await appendJsonl(config, RETRIEVE_CONTEXT_TOOL_LOG_FILENAME, entry);
}

export async function appendChatWorkflowLogEntry(config, entry) {
  await appendJsonl(config, CHAT_WORKFLOW_LOG_FILENAME, entry);
}

export async function logChatWorkflowStep({
  config,
  traceId = null,
  stage,
  query,
  data = {},
}) {
  const entry = {
    timestamp: new Date().toISOString(),
    traceId,
    stage,
    collection: config.qdrantCollection,
    query: truncateText(query || "", 500),
    data: sanitizeLogValue(data),
  };

  try {
    await appendChatWorkflowLogEntry(config, entry);
    console.log(
      JSON.stringify({
        type: "chat_workflow",
        timestamp: entry.timestamp,
        traceId: entry.traceId,
        stage: entry.stage,
        collection: entry.collection,
        query: entry.query,
        data: entry.data,
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "chat_workflow_log_error",
        stage,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function logChatInteraction({
  config,
  traceId,
  query,
  topK,
  filter,
  history,
  requestSource,
  answer,
  citations,
  chunks,
  toolCalls,
  error,
}) {
  const status = error
    ? "error"
    : Array.isArray(chunks) && chunks.length
      ? "success"
      : "no_chunks";
  const entry = {
    timestamp: new Date().toISOString(),
    traceId,
    status,
    collection: config.qdrantCollection,
    requestSource: requestSource || "unknown",
    query,
    topK: sanitizeTopK(topK),
    filter: sanitizeFilter(filter),
    historyCount: Array.isArray(history) ? history.length : 0,
    answer: answer || null,
    citationCount: Array.isArray(citations) ? citations.length : 0,
    chunkCount: Array.isArray(chunks) ? chunks.length : 0,
    toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
    citations:
      citations?.map((citation) => ({
        citationIndex: citation.citationIndex,
        url: citation.url,
        title: citation.title,
      })) || [],
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
          }
        : error
          ? String(error)
          : null,
  };

  await appendChatLogEntry(config, entry);
  console.log(
    JSON.stringify({
      type: "chat_log",
      timestamp: entry.timestamp,
      traceId: entry.traceId,
      status: entry.status,
      collection: entry.collection,
      requestSource: entry.requestSource,
      query: entry.query,
      answerPreview: entry.answer?.slice(0, 240) || null,
      toolCallCount: entry.toolCallCount,
      citationCount: entry.citationCount,
      chunkCount: entry.chunkCount,
      error: entry.error,
    }),
  );
}
