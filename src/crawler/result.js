import { createHash } from "node:crypto";
import { URL } from "node:url";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function hashToUuid(value) {
  const hash = sha256(value);
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join("-");
}
function getDomain(url) {
  return new URL(url).hostname;
}
function extractTitleFromMarkdown(markdown) {
  const heading = String(markdown || "").replace(/\r\n/gu, "\n").trim().split("\n").map((line) => line.trim()).find((line) => line);
  if (!heading) {
    return "Untitled";
  }
  return heading.replace(/^#{1,6}\s+/u, "").trim() || "Untitled";
}

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

function buildRawDocFromCrawlResult({
  url,
  result,
  fetchedAt = new Date().toISOString(),
  taskId = null,
  source = "crawl4ai",
}) {
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

  return {
    extracted,
    title,
    rawDoc: {
      docId: hashToUuid(url),
      url,
      domain: getDomain(url),
      title,
      fetchedAt,
      cleanedText,
      contentHash: sha256(cleanedText),
      metadata: {
        taskId,
        source,
        status: result?.success === false ? "failed" : "completed",
        crawlMetadata: result?.metadata || {},
        statusCode: result?.status_code ?? null,
        redirectedUrl: result?.redirected_url || null,
      },
    },
  };
}

export { firstDefined, pickResultPayload, extractCleanedText, buildRawDocFromCrawlResult };
