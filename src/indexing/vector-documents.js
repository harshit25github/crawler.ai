import { chunkDocument } from "./chunker.js";
import { extractBaggageDirectoryRows, normalizeDocument } from "./hybrid-documents.js";

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
}

function enrichChunk(document, chunk) {
  const sectionPath = Array.isArray(chunk.sectionPath)
    ? chunk.sectionPath.filter(Boolean)
    : [];
  const sectionTitle = sectionPath.length ? sectionPath.at(-1) : null;

  return {
    ...chunk,
    canonicalUrl: document.canonicalUrl,
    redirectedUrl: document.redirectedUrl,
    sourceType: document.sourceType,
    authority: document.authority,
    qualityStatus: document.qualityStatus,
    retrievalAllowed: document.retrievalAllowed,
    airlineName: document.airlineName,
    airlineSlug: document.airlineSlug,
    sectionId: chunk.id,
    sectionIndex: chunk.chunkIndex,
    partIndex: 0,
    sectionTitle,
    sectionSlug: sectionTitle ? slugify(sectionTitle) : null,
    anchorText: sectionTitle,
  };
}

function buildVectorArtifacts(rawDoc, options = {}) {
  const document = normalizeDocument(rawDoc, options);
  const chunks = chunkDocument(document, options).map((chunk) =>
    enrichChunk(document, chunk),
  );
  const directoryRows = extractBaggageDirectoryRows(document);
  const records =
    document.sourceType === "baggage_directory"
      ? [...directoryRows, ...chunks]
      : [...chunks];

  return {
    document,
    chunks,
    directoryRows,
    records,
  };
}

export { buildVectorArtifacts };
