import { URL } from "node:url";
import { sha256 } from "./hash.js";

function getDomain(url) {
  return new URL(url).hostname;
}

function fileStemForUrl(url) {
  const parsed = new URL(url);
  const base = `${parsed.hostname}${parsed.pathname}`
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();

  return `${base || "document"}-${sha256(url).slice(0, 12)}`;
}

export { getDomain, fileStemForUrl };
