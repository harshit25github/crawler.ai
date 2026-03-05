import { sleep } from "../lib/async.js";
import { getJson, postJson } from "../lib/http.js";

function trimTrailingSlashes(value) {
  return value.replace(/\/+$/u, "");
}

function addQueryParams(path, params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    query.set(key, String(value));
  }

  const encoded = query.toString();
  if (!encoded) {
    return path;
  }

  return `${path}?${encoded}`;
}

export function extractTaskId(payload) {
  return payload?.task_id || payload?.result?.task_id || null;
}

function normalizeUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("urls must be a non-empty array.");
  }

  const normalized = urls
    .map((url) => String(url || "").trim())
    .filter(Boolean);

  if (!normalized.length) {
    throw new Error("urls must contain at least one non-empty URL.");
  }

  return [...new Set(normalized)];
}

export class Crawl4AIUtility {
  constructor(config) {
    this.baseUrl = trimTrailingSlashes(config.crawl4aiBaseUrl);
    this.pollIntervalMs = config.crawl4aiPollIntervalMs;
    this.timeoutMs = config.crawl4aiTimeoutMs;
  }

  async get(path) {
    return getJson(`${this.baseUrl}${path}`);
  }

  async post(path, payload) {
    return postJson(`${this.baseUrl}${path}`, payload);
  }

  async crawl(payload) {
    return this.post("/crawl", payload);
  }

  async crawlSingle(url, crawlerConfig = {}) {
    return this.crawl({
      urls: [url],
      crawler_config: crawlerConfig,
    });
  }

  async runMultiUrlJob(urls, crawlerConfig = {}, options = {}) {
    return this.runCrawlJob(
      {
        urls: normalizeUrls(urls),
        crawler_config: crawlerConfig,
      },
      options,
    );
  }

  async runDeepCrawlJob(
    seedUrl,
    deepCrawlConfig = {},
    crawlerConfig = {},
    options = {},
  ) {
    const url = String(seedUrl || "").trim();

    if (!url) {
      throw new Error("seedUrl is required for deep crawl job.");
    }

    return this.runCrawlJob(
      {
        urls: [url],
        crawler_config: {
          ...crawlerConfig,
          deep_crawl_strategy: deepCrawlConfig,
        },
      },
      options,
    );
  }

  async *crawlStream(payload) {
    const response = await fetch(`${this.baseUrl}/crawl/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Crawl stream failed (${response.status}): ${text}`);
    }

    if (!response.body) {
      throw new Error("Crawl stream response had no body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        yield JSON.parse(trimmed);
      }
    }

    const tail = buffer.trim();
    if (tail) {
      yield JSON.parse(tail);
    }
  }

  async submitCrawlJob(payload) {
    return this.post("/crawl/job", payload);
  }

  async getCrawlJob(taskId) {
    return this.get(`/crawl/job/${taskId}`);
  }

  async waitForCrawlJob(taskId, options = {}) {
    const intervalMs = options.intervalMs || this.pollIntervalMs;
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;

    while (Date.now() < deadline) {
      const statusPayload = await this.getCrawlJob(taskId);
      const status = String(statusPayload?.status || "").toLowerCase();
      pollCount += 1;

      if (options.onPoll) {
        await options.onPoll({
          taskId,
          pollCount,
          status,
          payload: statusPayload,
        });
      }

      if (status === "completed") {
        return statusPayload;
      }

      if (status === "failed" || status === "cancelled") {
        throw new Error(`Crawl job ${taskId} ended with status ${status}.`);
      }

      await sleep(intervalMs);
    }

    throw new Error(`Timed out while waiting for crawl job ${taskId}.`);
  }

  async runCrawlJob(payload, options = {}) {
    const submitted = await this.submitCrawlJob(payload);
    const taskId = extractTaskId(submitted);

    if (!taskId) {
      throw new Error("Crawl4AI did not return a task_id for crawl job.");
    }

    const completed = await this.waitForCrawlJob(taskId, options);

    return {
      taskId,
      submitted,
      completed,
    };
  }

  async submitLlmJob(payload) {
    return this.post("/llm/job", payload);
  }

  async getLlmJob(taskId) {
    return this.get(`/llm/job/${taskId}`);
  }

  async waitForLlmJob(taskId, options = {}) {
    const intervalMs = options.intervalMs || this.pollIntervalMs;
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;

    while (Date.now() < deadline) {
      const statusPayload = await this.getLlmJob(taskId);
      const status = String(statusPayload?.status || "").toLowerCase();
      pollCount += 1;

      if (options.onPoll) {
        await options.onPoll({
          taskId,
          pollCount,
          status,
          payload: statusPayload,
        });
      }

      if (status === "completed") {
        return statusPayload;
      }

      if (status === "failed" || status === "cancelled") {
        throw new Error(`LLM job ${taskId} ended with status ${status}.`);
      }

      await sleep(intervalMs);
    }

    throw new Error(`Timed out while waiting for llm job ${taskId}.`);
  }

  async runLlmJob(payload, options = {}) {
    const submitted = await this.submitLlmJob(payload);
    const taskId = extractTaskId(submitted);

    if (!taskId) {
      throw new Error("Crawl4AI did not return a task_id for llm job.");
    }

    const completed = await this.waitForLlmJob(taskId, options);

    return {
      taskId,
      submitted,
      completed,
    };
  }

  async markdown(payload) {
    return this.post("/md", payload);
  }

  async html(payload) {
    return this.post("/html", payload);
  }

  async screenshot(payload) {
    return this.post("/screenshot", payload);
  }

  async pdf(payload) {
    return this.post("/pdf", payload);
  }

  async executeJs(payload) {
    return this.post("/execute_js", payload);
  }

  async health() {
    return this.get("/health");
  }

  async monitorHealth() {
    return this.get("/monitor/health");
  }

  async monitorRequests(params = {}) {
    return this.get(addQueryParams("/monitor/requests", params));
  }

  async monitorBrowsers() {
    return this.get("/monitor/browsers");
  }

  async monitorEndpointStats() {
    return this.get("/monitor/endpoints/stats");
  }
}
