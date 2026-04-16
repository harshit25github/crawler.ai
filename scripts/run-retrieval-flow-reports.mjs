import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKbSystem } from "../src/agents/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const OUTPUT_DIR = resolve(ROOT_DIR, "data", "logs");
const DEFAULT_REPORT_PATH = resolve(
  ROOT_DIR,
  "data",
  "evals",
  "complex-latest",
  "report.json",
);

const QUERY_RUNS = [
  {
    key: "airline",
    title: "Airline Retrieval Tool Flow",
    query:
      "According to the CheapOair baggage fees page, what are Aegean Airlines carry-on and 1st bag details?",
    topK: 4,
    filter: {
      domain: "www.cheapoair.com",
      sourceType: "baggage_directory",
    },
  },
  {
    key: "policy",
    title: "Policy Retrieval Tool Flow",
    query: "What personal information does CheapOair collect and how do they use it?",
    topK: 4,
    filter: {
      domain: "www.cheapoair.com",
      sourceType: "privacy_policy",
    },
  },
];

async function resolveCollection() {
  if (process.env.QDRANT_COLLECTION?.trim()) {
    return process.env.QDRANT_COLLECTION.trim();
  }

  try {
    const report = JSON.parse(await readFile(DEFAULT_REPORT_PATH, "utf8"));
    return report.qdrantCollection || undefined;
  } catch {
    return undefined;
  }
}

function formatValue(value) {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function formatTraceSteps(steps = []) {
  if (!steps.length) {
    return "No retrieval trace steps were recorded.";
  }

  return steps
    .map((step, index) => {
      const { at, stage, ...details } = step;
      return [
        `${index + 1}. [${at}] ${stage}`,
        Object.keys(details).length ? formatValue(details) : "No extra details.",
      ].join("\n");
    })
    .join("\n\n");
}

function formatToolCalls(toolCalls = []) {
  if (!toolCalls.length) {
    return "No tool calls were recorded.";
  }

  return toolCalls
    .map((call) =>
      [
        `Tool Call #${call.toolCallIndex}`,
        `Timestamp: ${call.timestamp}`,
        `Trace ID: ${call.traceId || "n/a"}`,
        `Tool Input: ${formatValue(call.toolInput)}`,
        `Applied TopK: ${call.appliedTopK}`,
        `Applied Filter: ${formatValue(call.appliedFilter)}`,
        `Result Count: ${call.resultCount}`,
        `Results Summary: ${formatValue(call.results)}`,
        `Error: ${formatValue(call.error)}`,
        "Execution Trace:",
        formatTraceSteps(call.retrievalTrace),
      ].join("\n"),
    )
    .join("\n\n========================================\n\n");
}

function formatCitations(citations = []) {
  if (!citations.length) {
    return "No citations returned.";
  }

  return citations
    .map(
      (citation) =>
        `- [${citation.citationIndex}] ${citation.title || "Untitled"} | ${citation.url}`,
    )
    .join("\n");
}

function buildReportText({ run, collection, result, debugContext, error }) {
  return [
    run.title,
    `Generated At: ${new Date().toISOString()}`,
    `Collection: ${collection || "default"}`,
    `Trace ID: ${debugContext.traceId || "n/a"}`,
    "",
    "Query",
    run.query,
    "",
    "Base Retrieval Filter",
    formatValue(run.filter),
    "",
    "Why This Query Was Chosen",
    run.key === "airline"
      ? "This query exercises the airline/baggage flow: agent -> retrieve_context tool -> baggage directory row scoring -> linked policy expansion."
      : "This query exercises the policy flow: agent -> retrieve_context tool -> HyDE search plans -> vector fusion -> privacy topic coverage.",
    "",
    "Final Assistant Answer",
    error ? `ERROR: ${error.message}` : result.answer,
    "",
    "Final Citations",
    formatCitations(result?.citations || []),
    "",
    "Tool Call Breakdown",
    formatToolCalls(debugContext.toolCalls || []),
  ].join("\n");
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const qdrantCollection = await resolveCollection();
  const kb = createKbSystem(
    qdrantCollection ? { qdrantCollection } : {},
  );
  const writtenFiles = [];

  for (const run of QUERY_RUNS) {
    const debugContext = {};
    let result = null;
    let error = null;

    try {
      result = await kb.answerQuery({
        query: run.query,
        topK: run.topK,
        filter: run.filter,
        requestSource: "flow_report",
        debugContext,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
      result = {
        answer: "",
        citations: [],
        chunks: [],
      };
    }

    const filePath = join(OUTPUT_DIR, `retrieval-flow-${run.key}.txt`);
    await writeFile(
      filePath,
      buildReportText({
        run,
        collection: kb.config.qdrantCollection,
        result,
        debugContext,
        error,
      }),
      "utf8",
    );
    writtenFiles.push(filePath);
  }

  console.log(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      collection: kb.config.qdrantCollection,
      files: writtenFiles,
    }),
  );
}

await main();
