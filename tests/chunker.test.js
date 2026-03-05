import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkDocument,
  extractTitleFromMarkdown,
} from "../src/lib/chunker.js";

test("extractTitleFromMarkdown uses the first heading", () => {
  const title = extractTitleFromMarkdown("# Privacy Policy\n\nBody");
  assert.equal(title, "Privacy Policy");
});

test("chunkDocument keeps section metadata and splits long content", () => {
  const paragraph = "This is a test paragraph about personal information collection.";
  const rawDoc = {
    docId: "doc-1",
    url: "https://example.com/privacy",
    title: "Privacy Policy",
    fetchedAt: "2026-03-03T00:00:00.000Z",
    contentHash: "hash-1",
    cleanedText: [
      "# Privacy Policy",
      "",
      "## Personal Information",
      "",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
      "",
      "## Cookies",
      "",
      "We use cookies to improve service.",
    ].join("\n"),
  };

  const chunks = chunkDocument(rawDoc, {
    targetChars: 140,
    overlapChars: 30,
  });

  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].sectionPath.at(-1), "Personal Information");
  assert.match(chunks[0].text, /Personal Information/u);
  assert.equal(chunks.at(-1).sectionPath.at(-1), "Cookies");
});
