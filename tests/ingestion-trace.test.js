import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildChunkingSummary,
  createIngestionTrace,
} from "../src/lib/ingestion-trace.js";

test("buildChunkingSummary returns basic chunk stats", () => {
  const summary = buildChunkingSummary([
    { text: "alpha", sectionPath: ["A"] },
    { text: "beta beta", sectionPath: ["A", "B"] },
  ]);

  assert.equal(summary.chunkCount, 2);
  assert.equal(summary.minChunkLength, 5);
  assert.equal(summary.maxChunkLength, 9);
  assert.equal(summary.averageChunkLength, 7);
  assert.deepEqual(summary.sampleSectionPaths, ["A", "A > B"]);
});

test("createIngestionTrace persists steps and summary", async () => {
  const tracesDir = await mkdtemp(join(tmpdir(), "crawler-trace-"));
  const trace = createIngestionTrace({
    config: {
      paths: { tracesDir },
      crawl4aiBaseUrl: "http://localhost:11235",
      qdrantUrl: "http://localhost:6333",
      qdrantCollection: "url_kb",
      openAiBaseUrl: "https://api.openai.com/v1",
      openAiEmbeddingModel: "text-embedding-3-small",
      openAiChatModel: "gpt-4o-mini",
      openAiApiKey: "secret-value",
      ingestConcurrency: 3,
      crawl4aiPollIntervalMs: 3000,
      crawl4aiTimeoutMs: 120000,
      chunking: {
        targetChars: 4500,
        overlapChars: 500,
      },
    },
    url: "https://example.com/privacy",
  });

  try {
    await trace.recordStep({
      stage: "pipeline_started",
      message: "Started trace.",
    });
    await trace.complete({
      status: "completed",
      chunkCount: 2,
    });

    const saved = JSON.parse(await readFile(trace.tracePath, "utf8"));

    assert.equal(saved.status, "completed");
    assert.equal(saved.steps.length, 1);
    assert.equal(saved.summary.chunkCount, 2);
    assert.equal(saved.requirements.environment.OPENAI_API_KEY, true);
  } finally {
    await rm(tracesDir, { recursive: true, force: true });
  }
});
