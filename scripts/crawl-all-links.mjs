import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import { Crawl4AIUtility } from "../src/crawler.js";
import { config } from "../src/indexing.js";

function parseArgs(argv) {
  const args = {};

  for (const raw of argv) {
    if (!raw.startsWith("--")) {
      continue;
    }

    const [key, value] = raw.slice(2).split("=");
    args[key] = value ?? "true";
  }

  return args;
}

function toInt(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function makeSafeName(url, index) {
  const safe = url
    .replace(/^https?:\/\//u, "")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 120);

  return `${String(index + 1).padStart(4, "0")}-${safe || "url"}.json`;
}

function collectUrls(payload) {
  const internal = Array.isArray(payload?.links?.internal)
    ? payload.links.internal
    : [];
  const external = Array.isArray(payload?.links?.external)
    ? payload.links.external
    : [];

  const all = [...internal, ...external];
  const unique = [];
  const seen = new Set();

  for (const item of all) {
    const href = String(item?.href || item?.url || "").trim();
    if (!href) {
      continue;
    }

    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }
    } catch {
      continue;
    }

    if (seen.has(href)) {
      continue;
    }

    seen.add(href);
    unique.push(href);
  }

  return unique;
}

function pickResult(response, url) {
  const results = Array.isArray(response?.results)
    ? response.results
    : Array.isArray(response?.result?.results)
      ? response.result.results
      : [];

  return (
    results.find((item) => item?.url === url) ||
    results[0] ||
    null
  );
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runWorker() {
    while (true) {
      const current = index;
      index += 1;

      if (current >= items.length) {
        break;
      }

      results[current] = await worker(items[current], current);
    }
  }

  const count = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: count }, () => runWorker()));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(
    process.cwd(),
    args.input || "data/crawl4ai/links-www-cheapoair-com-travel-baggage-fees.json",
  );
  const runLabel = args.label || "baggage-fees-all-links";
  const outBase = resolve(process.cwd(), "data/crawl4ai/runs");
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${runLabel}`;
  const outDir = join(outBase, runId);
  const rawDir = join(outDir, "raw-responses");
  const logsDir = join(outDir, "logs");
  const progressPath = join(logsDir, "progress.ndjson");
  const concurrency = toInt(args.concurrency, 6);
  const limit = toInt(args.limit, 0);
  const cacheMode = args.cacheMode || "bypass";

  const file = await readFile(inputPath, "utf8");
  const payload = JSON.parse(file);
  let urls = collectUrls(payload);
  if (limit > 0) {
    urls = urls.slice(0, limit);
  }

  const crawlConfig = { cache_mode: cacheMode };
  const runtimeConfig = {
    ...config,
    crawl4aiBaseUrl:
      process.env.CRAWL4AI_BASE_URL ||
      config.crawl4aiBaseUrl.replace("localhost", "127.0.0.1"),
  };
  const utility = new Crawl4AIUtility(runtimeConfig);

  await mkdir(rawDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  async function logEvent(event) {
    const record = {
      at: new Date().toISOString(),
      ...event,
    };
    await appendFile(progressPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  await writeFile(
    join(outDir, "run-meta.json"),
    `${JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        inputPath,
        totalUrls: urls.length,
        concurrency,
        crawlConfig,
        crawl4aiBaseUrl: runtimeConfig.crawl4aiBaseUrl,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`Run directory: ${outDir}`);
  console.log(`Total links to crawl: ${urls.length}`);
  console.log(`Concurrency: ${concurrency}`);

  const startedAt = Date.now();
  const results = await mapWithConcurrency(urls, concurrency, async (url, index) => {
    const startMs = Date.now();
    await logEvent({
      type: "crawl_started",
      index,
      url,
    });

    try {
      const response = await utility.crawl({
        urls: [url],
        crawler_config: crawlConfig,
      });

      const result = pickResult(response, url);
      const fileName = makeSafeName(url, index);
      const filePath = join(rawDir, fileName);
      const markdown =
        typeof result?.markdown === "string"
          ? result.markdown
          : result?.markdown?.fit_markdown ||
            result?.markdown?.raw_markdown ||
            "";

      await writeFile(
        filePath,
        `${JSON.stringify(
          {
            fetchedAt: new Date().toISOString(),
            index,
            url,
            response,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const elapsedMs = Date.now() - startMs;
      const summary = {
        status: "success",
        index,
        url,
        filePath,
        elapsedMs,
        success: Boolean(result?.success),
        statusCode: result?.status_code ?? null,
        title: result?.metadata?.title || null,
        markdownLength: markdown.length,
        errorMessage: result?.error_message || null,
      };

      await logEvent({
        type: "crawl_completed",
        ...summary,
      });

      return summary;
    } catch (error) {
      const elapsedMs = Date.now() - startMs;
      const summary = {
        status: "failed",
        index,
        url,
        elapsedMs,
        error: error.message,
      };

      await logEvent({
        type: "crawl_failed",
        ...summary,
      });

      return summary;
    }
  });

  const totalElapsedMs = Date.now() - startedAt;
  const succeeded = results.filter((item) => item.status === "success");
  const failed = results.filter((item) => item.status === "failed");

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    totalElapsedMs,
    total: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
    crawl4aiBaseUrl: runtimeConfig.crawl4aiBaseUrl,
    inputPath,
    outputDir: outDir,
    rawDir,
    progressLog: progressPath,
    failedItems: failed,
  };

  await writeFile(join(outDir, "result-index.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  await writeFile(join(outDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await logEvent({
    type: "run_completed",
    summary: {
      total: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
      totalElapsedMs: summary.totalElapsedMs,
    },
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
