import { hashToUuid, sha256 } from "../lib/hash.js";
import { getJson, postJson } from "../lib/http.js";
import { sleep } from "../lib/async.js";
import { extractTitleFromMarkdown } from "../lib/chunker.js";
import { getDomain } from "../lib/url.js";

function firstDefined(values) {
  return values.find(
    (value) =>
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim() === ""),
  );
}

function pickResultPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  if (Array.isArray(payload)) {
    return pickResultPayload(payload[0]);
  }

  if (Array.isArray(payload.results)) {
    return pickResultPayload(payload.results[0]);
  }

  if (Array.isArray(payload.data)) {
    return pickResultPayload(payload.data[0]);
  }

  if (payload.result && payload.result !== payload) {
    return pickResultPayload(payload.result);
  }

  return payload;
}

function extractCleanedText(result) {
  const candidates = [
    ["markdown.fit_markdown", result?.markdown?.fit_markdown],
    ["markdown.raw_markdown", result?.markdown?.raw_markdown],
    ["markdown", typeof result?.markdown === "string" ? result.markdown : null],
    ["cleaned_text", result?.cleaned_text],
    ["text", result?.text],
    ["content", result?.content],
    ["extracted_content", result?.extracted_content],
  ];

  const selected = candidates.find(
    ([, value]) =>
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim() === ""),
  );

  return {
    source: selected?.[0] || null,
    text: selected?.[1] || null,
  };
}

export class Crawl4AIClient {
  constructor(config) {
    this.baseUrl = config.crawl4aiBaseUrl.replace(/\/+$/u, "");
    this.pollIntervalMs = config.crawl4aiPollIntervalMs;
    this.timeoutMs = config.crawl4aiTimeoutMs;
  }

  async submitJob(url) {
    const response = await postJson(`${this.baseUrl}/crawl/job`, {
      urls: [url],
    });

    const taskId = response?.task_id || response?.result?.task_id;

    if (!taskId) {
      throw new Error("Crawl4AI did not return a task_id.");
    }

    return {
      taskId,
      response,
    };
  }

  async getJob(taskId) {
    return getJson(`${this.baseUrl}/crawl/job/${taskId}`);
  }

  async crawlUrl(url, options = {}) {
    const { trace } = options;

    await trace?.recordStep({
      stage: "crawl4ai_submit_request",
      message: "Submitting URL to Crawl4AI.",
      data: {
        endpoint: `${this.baseUrl}/crawl/job`,
        url,
      },
    });

    const submit = await this.submitJob(url);
    const taskId = submit.taskId;
    const deadline = Date.now() + this.timeoutMs;
    let pollCount = 0;

    await trace?.recordStep({
      stage: "crawl4ai_submit_response",
      status: "success",
      message: "Crawl4AI accepted the async crawl job.",
      data: {
        taskId,
        responseKeys: Object.keys(submit.response || {}),
      },
    });

    while (Date.now() < deadline) {
      const job = await this.getJob(taskId);
      const status = (job?.status || "").toLowerCase();
      pollCount += 1;

      await trace?.recordStep({
        stage: "crawl4ai_poll",
        message: "Polled Crawl4AI job status.",
        data: {
          taskId,
          pollCount,
          status,
        },
      });

      if (status === "completed") {
        const result = pickResultPayload(job);
        const extracted = extractCleanedText(result);
        const cleanedText = extracted.text?.trim();

        if (!cleanedText) {
          throw new Error(`Crawl completed for ${url}, but no text was extracted.`);
        }

        const title =
          firstDefined([
            result?.metadata?.title,
            result?.title,
            extractTitleFromMarkdown(cleanedText),
          ]) || "Untitled";

        await trace?.recordStep({
          stage: "crawl4ai_completed",
          status: "success",
          message: "Crawl4AI returned extracted content.",
          data: {
            taskId,
            pollCount,
            title,
            textLength: cleanedText.length,
            extractedFrom: extracted.source,
            metadataKeys: Object.keys(result?.metadata || {}),
            redirectedUrl: result?.redirected_url || null,
            statusCode: result?.status_code || null,
          },
        });

        return {
          rawDoc: {
            docId: hashToUuid(url),
            url,
            domain: getDomain(url),
            title,
            fetchedAt: new Date().toISOString(),
            cleanedText,
            contentHash: sha256(cleanedText),
            metadata: {
              taskId,
              source: "crawl4ai",
              status,
              crawlMetadata: result?.metadata || {},
            },
          },
          crawl4aiResponse: {
            url,
            taskId,
            fetchedAt: new Date().toISOString(),
            submitResponse: submit.response,
            completedJobResponse: job,
            selectedResultPayload: result,
            selectedContent: {
              source: extracted.source,
              textLength: cleanedText.length,
            },
          },
        };
      }

      if (status === "failed" || status === "cancelled") {
        await trace?.recordStep({
          stage: "crawl4ai_terminal_failure",
          status: "error",
          message: `Crawl4AI job ended with status ${status}.`,
          data: {
            taskId,
            pollCount,
          },
        });
        throw new Error(`Crawl4AI job ${taskId} ended with status ${status}.`);
      }

      await sleep(this.pollIntervalMs);
    }

    await trace?.recordStep({
      stage: "crawl4ai_timeout",
      status: "error",
      message: "Timed out while polling Crawl4AI.",
      data: {
        taskId,
        timeoutMs: this.timeoutMs,
        pollCount,
      },
    });

    throw new Error(`Timed out waiting for Crawl4AI job ${taskId}.`);
  }
}
