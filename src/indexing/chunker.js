import { hashToUuid, sha256 } from "./hash.js";
import { getDomain } from "./url.js";

function normalizeText(text) {
  return text.replace(/\r\n/gu, "\n").trim();
}

function splitMarkdownBlocks(markdown) {
  const lines = normalizeText(markdown).split("\n");
  const blocks = [];
  let buffer = [];

  function flushParagraph() {
    if (!buffer.length) {
      return;
    }

    const text = buffer.join("\n").trim();
    if (text) {
      blocks.push({ type: "paragraph", text });
    }

    buffer = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/u);

    if (headingMatch) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    buffer.push(line);
  }

  flushParagraph();
  return blocks;
}

function splitOversizedSegment(text, targetChars) {
  const normalized = normalizeText(text || "");
  if (!normalized) {
    return [];
  }

  if (!targetChars || normalized.length <= targetChars) {
    return [normalized];
  }

  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const segments = [];
    let current = [];
    let currentLength = 0;

    for (const line of lines) {
      const lineLength = line.length + (current.length ? 1 : 0);

      if (current.length && currentLength + lineLength > targetChars) {
        segments.push(current.join("\n"));
        current = [];
        currentLength = 0;
      }

      if (line.length > targetChars) {
        if (current.length) {
          segments.push(current.join("\n"));
          current = [];
          currentLength = 0;
        }

        for (let index = 0; index < line.length; index += targetChars) {
          segments.push(line.slice(index, index + targetChars));
        }
        continue;
      }

      current.push(line);
      currentLength += lineLength;
    }

    if (current.length) {
      segments.push(current.join("\n"));
    }

    return segments.filter(Boolean);
  }

  const segments = [];
  for (let index = 0; index < normalized.length; index += targetChars) {
    segments.push(normalized.slice(index, index + targetChars));
  }
  return segments;
}

function updateHeadingStack(stack, level, text) {
  const next = stack.slice(0, level - 1);
  next[level - 1] = text;
  return next;
}

function collectOverlapParagraphs(paragraphs, overlapChars) {
  if (!overlapChars || !paragraphs.length) {
    return [];
  }

  const overlap = [];
  let total = 0;

  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    overlap.unshift(paragraphs[index]);
    total += paragraphs[index].length;

    if (total >= overlapChars) {
      break;
    }
  }

  return overlap;
}

function buildChunkText(leadHeading, paragraphs) {
  return [leadHeading, ...paragraphs].filter(Boolean).join("\n\n").trim();
}

function extractTitleFromMarkdown(markdown) {
  const heading = normalizeText(markdown)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line);

  if (!heading) {
    return "Untitled";
  }

  return heading.replace(/^#{1,6}\s+/u, "").trim() || "Untitled";
}

function chunkDocument(rawDoc, options) {
  const text = normalizeText(rawDoc.cleanedText || "");

  if (!text) {
    return [];
  }

  const blocks = splitMarkdownBlocks(text);
  const chunks = [];
  let headingStack = [];
  let pendingHeading = null;
  let currentParagraphs = [];
  let currentLeadHeading = null;
  let currentSectionPath = [];

  function flushChunk({ carryOverlap }) {
    if (!currentParagraphs.length) {
      return;
    }

    const chunkText = buildChunkText(currentLeadHeading, currentParagraphs);
    chunks.push({
      id: hashToUuid(`${rawDoc.docId}:${chunks.length}`),
      docId: rawDoc.docId,
      url: rawDoc.url,
      domain: getDomain(rawDoc.url),
      title: rawDoc.title || extractTitleFromMarkdown(rawDoc.cleanedText),
      chunkIndex: chunks.length,
      sectionPath: [...currentSectionPath],
      fetchedAt: rawDoc.fetchedAt,
      contentHash: rawDoc.contentHash,
      text: chunkText,
      textHash: sha256(chunkText),
    });

    if (carryOverlap) {
      currentParagraphs = collectOverlapParagraphs(
        currentParagraphs,
        options.overlapChars,
      );
    } else {
      currentParagraphs = [];
    }

    if (!currentParagraphs.length) {
      currentLeadHeading = null;
      currentSectionPath = [];
    }
  }

  for (const block of blocks) {
    if (block.type === "heading") {
      if (currentParagraphs.length) {
        flushChunk({ carryOverlap: false });
      }

      headingStack = updateHeadingStack(headingStack, block.level, block.text);
      pendingHeading = `${"#".repeat(block.level)} ${block.text}`;
      continue;
    }

    const segments = splitOversizedSegment(block.text, options.targetChars);

    for (const segment of segments) {
      if (!currentParagraphs.length) {
        currentSectionPath = [...headingStack];
        currentLeadHeading = pendingHeading;
        pendingHeading = null;
      }

      const nextParagraphs = [...currentParagraphs, segment];
      const prospectiveText = buildChunkText(currentLeadHeading, nextParagraphs);

      if (
        currentParagraphs.length > 0 &&
        prospectiveText.length > options.targetChars
      ) {
        flushChunk({ carryOverlap: true });

        if (!currentParagraphs.length) {
          currentSectionPath = [...headingStack];
          currentLeadHeading =
            pendingHeading ||
            currentLeadHeading ||
            (headingStack.length ? `## ${headingStack.at(-1)}` : null);
        }
      }

      if (!currentParagraphs.length) {
        currentSectionPath = [...headingStack];
        currentLeadHeading =
          pendingHeading ||
          currentLeadHeading ||
          (headingStack.length ? `## ${headingStack.at(-1)}` : null);
        pendingHeading = null;
      }

      currentParagraphs.push(segment);
    }
  }

  flushChunk({ carryOverlap: false });
  return chunks;
}

export { extractTitleFromMarkdown, chunkDocument };
