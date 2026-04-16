import { sleep } from "./async.js";
import { getJson, postJson } from "./http.js";
import { buildRawDocFromCrawlResult, pickResultPayload } from "./result.js";

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
        const fetchedAt = new Date().toISOString();
        const { rawDoc, extracted, title } = buildRawDocFromCrawlResult({
          url,
          result,
          taskId,
          fetchedAt,
        });

        await trace?.recordStep({
          stage: "crawl4ai_completed",
          status: "success",
          message: "Crawl4AI returned extracted content.",
          data: {
            taskId,
            pollCount,
            title,
            textLength: rawDoc.cleanedText.length,
            extractedFrom: extracted.source,
            metadataKeys: Object.keys(result?.metadata || {}),
            redirectedUrl: result?.redirected_url || null,
            statusCode: result?.status_code || null,
          },
        });

        return {
          rawDoc,
          crawl4aiResponse: {
            url,
            taskId,
            fetchedAt,
            submitResponse: submit.response,
            completedJobResponse: job,
            selectedResultPayload: result,
            selectedContent: {
              source: extracted.source,
              textLength: rawDoc.cleanedText.length,
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
