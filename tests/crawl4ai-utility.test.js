import test from "node:test";
import assert from "node:assert/strict";
import {
  Crawl4AIUtility,
  extractTaskId,
} from "../src/services/crawl4ai-utility.js";

test("extractTaskId supports top-level and nested result payloads", () => {
  assert.equal(extractTaskId({ task_id: "crawl_123" }), "crawl_123");
  assert.equal(extractTaskId({ result: { task_id: "crawl_456" } }), "crawl_456");
  assert.equal(extractTaskId({}), null);
});

test("runMultiUrlJob forwards normalized urls and crawler_config", async () => {
  const utility = new Crawl4AIUtility({
    crawl4aiBaseUrl: "http://localhost:11235",
    crawl4aiPollIntervalMs: 1000,
    crawl4aiTimeoutMs: 10000,
  });
  let capturedPayload = null;

  utility.runCrawlJob = async (payload) => {
    capturedPayload = payload;
    return { taskId: "crawl_test", submitted: {}, completed: {} };
  };

  await utility.runMultiUrlJob(
    [" https://example.com/a ", "https://example.com/a", "https://example.com/b"],
    { cache_mode: "bypass" },
  );

  assert.deepEqual(capturedPayload, {
    urls: ["https://example.com/a", "https://example.com/b"],
    crawler_config: { cache_mode: "bypass" },
  });
});

test("runDeepCrawlJob adds deep_crawl_strategy in crawler_config", async () => {
  const utility = new Crawl4AIUtility({
    crawl4aiBaseUrl: "http://localhost:11235",
    crawl4aiPollIntervalMs: 1000,
    crawl4aiTimeoutMs: 10000,
  });
  let capturedPayload = null;

  utility.runCrawlJob = async (payload) => {
    capturedPayload = payload;
    return { taskId: "crawl_test", submitted: {}, completed: {} };
  };

  await utility.runDeepCrawlJob(
    "https://example.com/start",
    { type: "BFSDeepCrawlStrategy", max_depth: 2 },
    { cache_mode: "bypass" },
  );

  assert.deepEqual(capturedPayload, {
    urls: ["https://example.com/start"],
    crawler_config: {
      cache_mode: "bypass",
      deep_crawl_strategy: { type: "BFSDeepCrawlStrategy", max_depth: 2 },
    },
  });
});

test("runClientSideDeepCrawl walks discovered links with depth control", async () => {
  const utility = new Crawl4AIUtility({
    crawl4aiBaseUrl: "http://localhost:11235",
    crawl4aiPollIntervalMs: 1000,
    crawl4aiTimeoutMs: 10000,
  });

  utility.crawl = async (payload) => {
    const url = payload.urls[0];

    if (url === "https://example.com/start") {
      return {
        results: [
          {
            success: true,
            status_code: 200,
            metadata: { title: "Start" },
            markdown: { raw_markdown: "start content" },
            links: {
              internal: [{ href: "https://example.com/next" }],
              external: [{ href: "https://outside.com/x" }],
            },
          },
        ],
      };
    }

    if (url === "https://example.com/next") {
      return {
        results: [
          {
            success: true,
            status_code: 200,
            metadata: { title: "Next" },
            markdown: { raw_markdown: "next content" },
            links: {
              internal: [{ href: "https://example.com/end" }],
              external: [],
            },
          },
        ],
      };
    }

    if (url === "https://example.com/end") {
      return {
        results: [
          {
            success: true,
            status_code: 200,
            metadata: { title: "End" },
            markdown: { raw_markdown: "end content" },
            links: {
              internal: [],
              external: [],
            },
          },
        ],
      };
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await utility.runClientSideDeepCrawl(
    "https://example.com/start",
    {
      maxDepth: 2,
      maxPages: 10,
      includeExternal: false,
      crawlerConfig: { cache_mode: "bypass" },
    },
  );

  assert.equal(result.crawledCount, 3);
  assert.deepEqual(
    result.pages.map((page) => page.url),
    [
      "https://example.com/start",
      "https://example.com/next",
      "https://example.com/end",
    ],
  );
});
