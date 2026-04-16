import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readLinesFile } from "../indexing/index.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed"]);

function nowIso() {
  return new Date().toISOString();
}

function createJobId() {
  return `ingest_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function normalizeUrls(urls) {
  if (!Array.isArray(urls)) {
    return [];
  }

  return [...new Set(urls.map((url) => String(url || "").trim()).filter(Boolean))];
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
    };
  }

  return {
    name: "Error",
    message: String(error),
    stack: null,
  };
}

function buildInitialProgress(input) {
  const total = input.type === "urls" ? input.urls.length : 1;

  return {
    stage: "queued",
    total,
    completed: 0,
    ingested: 0,
    skipped: 0,
    failed: 0,
    currentUrl: null,
  };
}

function toPublicJob(job) {
  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: { ...job.progress },
    result: job.result,
    error: job.error,
  };
}

function createBadRequestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export class IngestJobManager {
  constructor({
    kb,
    concurrency = 1,
    retentionLimit = 100,
    scheduler = setImmediate,
  }) {
    this.kb = kb;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.retentionLimit = Math.max(1, Number(retentionLimit) || 100);
    this.scheduler = scheduler;
    this.jobs = new Map();
    this.queue = [];
    this.activeCount = 0;
    this.drainScheduled = false;
  }

  async normalizeInput(payload = {}) {
    if (payload.runDir) {
      return {
        type: "runDir",
        runDir: resolve(this.kb.config.paths.rootDir, String(payload.runDir)),
      };
    }

    let urls = payload.urls;
    if ((!urls || !urls.length) && payload.urlsFile) {
      urls = await readLinesFile(
        resolve(this.kb.config.paths.rootDir, String(payload.urlsFile)),
      );
    }

    const normalizedUrls = normalizeUrls(urls);
    if (!normalizedUrls.length) {
      throw createBadRequestError("Pass urls[] or urlsFile, or pass runDir.");
    }

    return {
      type: "urls",
      urls: normalizedUrls,
      force: Boolean(payload.force),
    };
  }

  async createJob(payload = {}) {
    const input = await this.normalizeInput(payload);
    const job = {
      jobId: createJobId(),
      type: input.type,
      status: "queued",
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      input,
      progress: buildInitialProgress(input),
      result: null,
      error: null,
    };

    this.jobs.set(job.jobId, job);
    this.queue.push(job.jobId);
    this.pruneJobs();
    this.scheduleDrain();

    return toPublicJob(job);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    return job ? toPublicJob(job) : null;
  }

  listJobs() {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => toPublicJob(job));
  }

  scheduleDrain() {
    if (this.drainScheduled) {
      return;
    }

    this.drainScheduled = true;
    this.scheduler(() => {
      this.drainScheduled = false;
      void this.drainQueue();
    });
  }

  async drainQueue() {
    while (this.activeCount < this.concurrency && this.queue.length) {
      const jobId = this.queue.shift();
      const job = this.jobs.get(jobId);

      if (!job || job.status !== "queued") {
        continue;
      }

      this.activeCount += 1;
      void this.runJob(job).finally(() => {
        this.activeCount -= 1;
        this.pruneJobs();
        this.scheduleDrain();
      });
    }
  }

  markRunning(job) {
    job.status = "running";
    job.startedAt = nowIso();
    job.progress = {
      ...job.progress,
      stage: job.type === "runDir" ? "importing_run" : "ingesting",
    };
  }

  updateFromUrlProgress(job, event) {
    if (!event || job.type !== "urls") {
      return;
    }

    if (event.event === "url_started") {
      job.progress = {
        ...job.progress,
        stage: "ingesting",
        currentUrl: event.url || null,
      };
      return;
    }

    if (event.event !== "url_completed") {
      return;
    }

    const result = event.result || {};
    job.progress = {
      ...job.progress,
      stage: "ingesting",
      completed: job.progress.completed + 1,
      ingested:
        job.progress.ingested + Number(result.status === "ingested" || false),
      skipped:
        job.progress.skipped + Number(result.status === "skipped" || false),
      failed: job.progress.failed + Number(result.status === "failed" || false),
      currentUrl: null,
    };
  }

  async runJob(job) {
    this.markRunning(job);

    try {
      if (job.type === "runDir") {
        job.result = await this.kb.ingestRunDirectory(job.input.runDir);
      } else {
        job.result = await this.kb.ingestUrls(job.input.urls, {
          force: job.input.force,
          onProgress: (event) => this.updateFromUrlProgress(job, event),
        });
      }

      job.status = "succeeded";
      job.finishedAt = nowIso();
      job.progress = {
        ...job.progress,
        stage: "succeeded",
        total: job.result?.total ?? job.progress.total,
        completed:
          job.result?.total ??
          job.progress.completed ??
          job.progress.total ??
          0,
        ingested: job.result?.ingested ?? job.progress.ingested,
        skipped: job.result?.skipped ?? job.progress.skipped,
        failed: job.result?.failed ?? job.progress.failed,
        currentUrl: null,
      };
    } catch (error) {
      job.status = "failed";
      job.finishedAt = nowIso();
      job.error = serializeError(error);
      job.progress = {
        ...job.progress,
        stage: "failed",
        currentUrl: null,
      };
    }
  }

  pruneJobs() {
    if (this.jobs.size <= this.retentionLimit) {
      return;
    }

    const terminalJobs = [...this.jobs.values()]
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    for (const job of terminalJobs) {
      if (this.jobs.size <= this.retentionLimit) {
        break;
      }

      this.jobs.delete(job.jobId);
    }
  }
}

export function createIngestJobManager(options) {
  return new IngestJobManager(options);
}
