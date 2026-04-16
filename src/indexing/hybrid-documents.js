import { hashToUuid, sha256 } from "./hash.js";
import { getDomain } from "./url.js";
import { BAGGAGE_FACETS } from "../retrieval/query-routing.js";

const UNUSABLE_TITLE_PATTERN =
  /\b(pardon our interruption|just a moment|forbidden|not found|access denied)\b/iu;
const UNUSABLE_TEXT_PATTERN =
  /\b(you were a bot|made us think you were a bot|forbidden|captcha|access denied)\b/iu;
const DIRECTORY_LABEL_PATTERN =
  /^(airlines|destinations|carryon|carry-on|1st bag|2nd bag|additional policy)$/iu;
const VALUE_LABEL_PATTERN =
  /^(destinations?|carryon|carry-on|1st bag|2nd bag|additional policy)\s*:/iu;
const NAVIGATION_LINE_PATTERN =
  /^(skip to|book now|call us|language|help & contact|searching top deals|loading)$/iu;
const PRIVACY_SUBHEADING_PATTERN = /^\*\*([^*]{3,120})\*\*$/u;
const PRIVACY_FOOTER_MARKER_PATTERN =
  /(i'?m done|earn 2x points on cheapoair app|sign up today and never miss another deal again|easy access|connect with us|react-lp-infopages)/iu;
const AIRLINE_CONTENT_HEADING_PATTERN =
  /^(#{1,6})\s+.*\b(allowance|carry[- ]on|checked baggage|policy|hand baggage|cabin baggage|luggage|baggage information)\b/iu;
const AIRLINE_FOOTER_MARKER_PATTERN =
  /(newsletter|download the .* app|follow us on|how would you rate your experience on our website|payment methods|copyright|all rights reserved)/iu;
const DIRECTORY_ROW_START_PATTERN = /^!\[[^\]]*\]\([^)]+\)(.+)$/u;
const DIRECTORY_FIELD_KEY_BY_LABEL = new Map([
  ["destinations", "destinations"],
  ["carryon", "carryOn"],
  ["carry-on", "carryOn"],
  ["1st bag", "firstBag"],
  ["2nd bag", "secondBag"],
  ["additional policy", "additionalPolicy"],
]);
const STRUCTURED_POLICY_SOURCE_TYPES = new Set([
  "privacy_policy",
  "cookie_policy",
  "terms_conditions",
]);

function normalizeText(text) {
  return String(text || "").replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function trimMarkdownDecorators(text) {
  return String(text || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[*_`>#]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function markdownLinks(text) {
  return [...String(text || "").matchAll(/\[[^\]]+\]\((https?:[^)]+)\)/gu)].map(
    (match) => match[1],
  );
}

function slugify(value) {
  return trimMarkdownDecorators(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
}

function compactSectionPath(path) {
  return path
    .filter((entry) => typeof entry === "string")
    .map((entry) => trimMarkdownDecorators(entry))
    .filter(Boolean);
}

function detectSourceType(url) {
  if (/\/info\/privacy/iu.test(url)) {
    return "privacy_policy";
  }

  if (/\/info\/cookie-policy\/?$/iu.test(url)) {
    return "cookie_policy";
  }

  if (/\/info\/generaltermsandconditions\/?$/iu.test(url)) {
    return "terms_conditions";
  }

  if (/\/travel\/baggage-fees\/?$/iu.test(url)) {
    return "baggage_directory";
  }

  return "airline_policy";
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
        text: trimMarkdownDecorators(headingMatch[2]),
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

function removeTableOfContents(lines) {
  const firstHeadingIndex = lines.findIndex((line) => /^(#{1,6})\s+/u.test(line));
  if (firstHeadingIndex < 0) {
    return lines;
  }

  const tocStart = firstHeadingIndex + 1;
  let tocEnd = tocStart;
  let tocLinkCount = 0;

  while (tocEnd < lines.length) {
    const line = lines[tocEnd];
    if (/^(#{1,6})\s+/u.test(line)) {
      break;
    }

    const trimmed = line.trim();
    if (trimmed && /^[-*]\s+\[[^\]]+\]\([^)]+\)/u.test(trimmed)) {
      tocLinkCount += 1;
    }

    tocEnd += 1;
  }

  if (tocLinkCount < 3) {
    return lines;
  }

  return [...lines.slice(0, firstHeadingIndex + 1), ...lines.slice(tocEnd)];
}

function promotePrivacySubheadings(lines) {
  return lines.map((line) => {
    const trimmed = line.trim();
    const match = trimmed.match(PRIVACY_SUBHEADING_PATTERN);
    if (!match) {
      return line;
    }

    return `#### ${trimMarkdownDecorators(match[1])}`;
  });
}

function trimPrivacyTail(lines) {
  const markerIndex = lines.findIndex((line) =>
    PRIVACY_FOOTER_MARKER_PATTERN.test(trimMarkdownDecorators(line)),
  );

  if (markerIndex < 0) {
    return lines;
  }

  return lines.slice(0, markerIndex);
}

function trimAirlinePolicyLead(lines) {
  const candidateIndex = lines.findIndex((line, index) => {
    if (index <= 0) {
      return false;
    }

    return AIRLINE_CONTENT_HEADING_PATTERN.test(line.trim());
  });

  if (candidateIndex < 0) {
    return lines;
  }

  return lines.slice(candidateIndex);
}

function trimAirlinePolicyTail(lines) {
  const markerIndex = lines.findIndex((line) =>
    AIRLINE_FOOTER_MARKER_PATTERN.test(trimMarkdownDecorators(line)),
  );

  if (markerIndex < 0) {
    return lines;
  }

  return lines.slice(0, markerIndex);
}

function cleanupMarkdown(text, sourceType) {
  let lines = normalizeText(text).split("\n");
  const firstHeadingIndex = lines.findIndex((line) => /^(#{1,6})\s+/u.test(line));

  if (firstHeadingIndex > 0) {
    lines = lines.slice(firstHeadingIndex);
  }

  if (sourceType === "privacy_policy") {
    lines = removeTableOfContents(lines);
    lines = trimPrivacyTail(lines);
    lines = promotePrivacySubheadings(lines);
  }

  if (STRUCTURED_POLICY_SOURCE_TYPES.has(sourceType)) {
    lines = removeTableOfContents(lines);
  }

  if (sourceType === "airline_policy") {
    lines = trimAirlinePolicyLead(lines);
    lines = trimAirlinePolicyTail(lines);
  }

  const cleaned = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const simplified = trimMarkdownDecorators(line);

    if (!line.trim()) {
      cleaned.push("");
      continue;
    }

    const linkCount = markdownLinks(line).length;
    const isLinkHeavy =
      linkCount >= 2 &&
      !/^(#{1,6})\s+/u.test(line) &&
      simplified.length < 80 * linkCount;

    if (NAVIGATION_LINE_PATTERN.test(simplified.toLowerCase())) {
      continue;
    }

    if (sourceType === "airline_policy" && isLinkHeavy) {
      continue;
    }

    if (
      sourceType === "airline_policy" &&
      simplified.length < 3 &&
      !/^(#{1,6})\s+/u.test(line)
    ) {
      continue;
    }

    cleaned.push(line);
  }

  return cleaned.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function updateHeadingStack(stack, level, text) {
  const next = stack.slice(0, Math.max(0, level - 1));
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

function classifyQuality({ doc, cleanedText }) {
  const title = doc.title || "";
  const statusCode = doc.metadata?.statusCode ?? null;
  const base = {
    qualityStatus: "usable",
    authority: doc.sourceType === "baggage_directory" ? "discovery_only" : "primary",
    retrievalAllowed: true,
  };

  if (doc.sourceType === "baggage_directory") {
    return base;
  }

  if (
    (statusCode && statusCode >= 400) ||
    UNUSABLE_TITLE_PATTERN.test(title) ||
    UNUSABLE_TEXT_PATTERN.test(cleanedText) ||
    cleanedText.length < 150
  ) {
    return {
      qualityStatus: "unusable",
      authority: "unusable",
      retrievalAllowed: false,
    };
  }

  return base;
}

function bestAirlineSegment(title, url) {
  const hostTokens = slugify(new URL(url).hostname)
    .split("-")
    .filter(Boolean);
  const segments = trimMarkdownDecorators(title)
    .split(/\s+\|\s+|\s+-\s+|:\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) {
    return hostTokens[0] || "unknown-airline";
  }

  const genericTokens = new Set([
    "baggage",
    "bag",
    "bags",
    "allowance",
    "allowances",
    "policy",
    "policies",
    "information",
    "travel",
    "services",
    "service",
    "help",
    "centre",
    "center",
  ]);

  let best = segments[0];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const segment of segments) {
    const tokens = slugify(segment).split("-").filter(Boolean);
    let score = tokens.length;

    for (const token of tokens) {
      if (genericTokens.has(token)) {
        score -= 2;
      }

      if (hostTokens.includes(token)) {
        score += 2;
      }
    }

    if (score > bestScore) {
      best = segment;
      bestScore = score;
    }
  }

  return best;
}

function metadataSiteName(metadata = {}) {
  const crawlMetadata = metadata?.crawlMetadata || {};
  const candidates = [
    crawlMetadata["og:site_name"],
    crawlMetadata["twitter:site"],
    crawlMetadata["application-name"],
    crawlMetadata.publisher,
  ]
    .map((value) => trimMarkdownDecorators(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (
      !/\b(baggage|allowance|policy|travel info|travel information|cabin|checked)\b/iu.test(
        candidate,
      )
    ) {
      return candidate;
    }
  }

  return null;
}

function deriveAirlineName({ title, url, metadata = {} }) {
  const siteName = metadataSiteName(metadata);
  if (siteName) {
    return siteName
      .replace(/\b(home|official site)\b/giu, "")
      .trim();
  }

  const segment = bestAirlineSegment(title, url);
  return trimMarkdownDecorators(segment)
    .replace(/\b(home|official site)\b/giu, "")
    .trim();
}

function normalizeDocument(rawDoc, options = {}) {
  const sourceType = options.sourceType || detectSourceType(rawDoc.url);
  const canonicalUrl =
    options.canonicalUrl ||
    rawDoc.metadata?.redirectedUrl ||
    rawDoc.url;
  const redirectedUrl = rawDoc.metadata?.redirectedUrl || null;
  const cleanedText = cleanupMarkdown(rawDoc.cleanedText || "", sourceType);
  const airlineName =
    options.airlineName ||
    (sourceType === "airline_policy"
      ? deriveAirlineName({
          title: rawDoc.title,
          url: canonicalUrl,
          metadata: rawDoc.metadata || {},
        })
      : null);
  const quality = classifyQuality({ doc: { ...rawDoc, sourceType }, cleanedText });

  return {
    ...rawDoc,
    canonicalUrl,
    redirectedUrl,
    sourceType,
    airlineName,
    airlineSlug: airlineName ? slugify(airlineName) : null,
    cleanedText,
    ...quality,
  };
}

function buildSections(doc, options = {}) {
  const text = doc.cleanedText;
  if (!text) {
    return [];
  }

  const targetChars = options.targetChars || 2200;
  const overlapChars = options.overlapChars || 200;
  const blocks = splitMarkdownBlocks(text);
  const sections = [];
  let headingStack = [];
  let pendingHeading = null;
  let currentParagraphs = [];
  let currentLeadHeading = null;
  let currentSectionPath = [];
  let sectionIndex = 0;
  let partIndex = 0;

  function flushSection({ carryOverlap }) {
    if (!currentParagraphs.length) {
      return;
    }

    const compactPath = compactSectionPath(currentSectionPath);
    const sectionTitle = compactPath.at(-1) || doc.title || "General";
    const chunkText = buildChunkText(currentLeadHeading, currentParagraphs);
    const sectionId = hashToUuid(`${doc.docId}:section:${sectionIndex}:${partIndex}`);

    sections.push({
      id: sectionId,
      sectionId,
      docId: doc.docId,
      url: doc.url,
      canonicalUrl: doc.canonicalUrl,
      redirectedUrl: doc.redirectedUrl,
      domain: getDomain(doc.canonicalUrl || doc.url),
      title: doc.title,
      airlineName: doc.airlineName,
      airlineSlug: doc.airlineSlug,
      sourceType: doc.sourceType,
      authority: doc.authority,
      qualityStatus: doc.qualityStatus,
      retrievalAllowed: doc.retrievalAllowed,
      fetchedAt: doc.fetchedAt,
      contentHash: doc.contentHash,
      sectionIndex,
      partIndex,
      sectionTitle,
      sectionPath: compactPath,
      sectionSlug: slugify(sectionTitle) || "general",
      anchorText: sectionTitle,
      text: chunkText,
      textHash: sha256(chunkText),
      statusCode: doc.metadata?.statusCode ?? null,
    });

    if (carryOverlap) {
      currentParagraphs = collectOverlapParagraphs(currentParagraphs, overlapChars);
      partIndex += 1;
    } else {
      currentParagraphs = [];
      currentLeadHeading = null;
      currentSectionPath = [];
      sectionIndex += 1;
      partIndex = 0;
    }
  }

  for (const block of blocks) {
    if (block.type === "heading") {
      if (currentParagraphs.length) {
        flushSection({ carryOverlap: false });
      }

      headingStack = updateHeadingStack(headingStack, block.level, block.text);
      pendingHeading = `${"#".repeat(block.level)} ${block.text}`;
      continue;
    }

    if (!currentParagraphs.length) {
      currentSectionPath = compactSectionPath(headingStack);
      currentLeadHeading = pendingHeading;
      pendingHeading = null;
    }

    const nextParagraphs = [...currentParagraphs, block.text];
    const prospectiveText = buildChunkText(currentLeadHeading, nextParagraphs);

    if (
      currentParagraphs.length > 0 &&
      prospectiveText.length > targetChars
    ) {
      flushSection({ carryOverlap: true });

      if (!currentParagraphs.length) {
        currentSectionPath = compactSectionPath(headingStack);
        currentLeadHeading =
          pendingHeading ||
          currentLeadHeading ||
          (currentSectionPath.length
            ? `## ${currentSectionPath.at(-1)}`
            : null);
      }
    }

    if (!currentParagraphs.length) {
      currentSectionPath = compactSectionPath(headingStack);
      currentLeadHeading =
        pendingHeading ||
        currentLeadHeading ||
        (currentSectionPath.length ? `## ${currentSectionPath.at(-1)}` : null);
      pendingHeading = null;
    }

    currentParagraphs.push(block.text);
  }

  flushSection({ carryOverlap: false });

  if (!sections.length) {
    const sectionId = hashToUuid(`${doc.docId}:section:0:0`);
    return [
      {
        id: sectionId,
        sectionId,
        docId: doc.docId,
        url: doc.url,
        canonicalUrl: doc.canonicalUrl,
        redirectedUrl: doc.redirectedUrl,
        domain: getDomain(doc.canonicalUrl || doc.url),
        title: doc.title,
        airlineName: doc.airlineName,
        airlineSlug: doc.airlineSlug,
        sourceType: doc.sourceType,
        authority: doc.authority,
        qualityStatus: doc.qualityStatus,
        retrievalAllowed: doc.retrievalAllowed,
        fetchedAt: doc.fetchedAt,
        contentHash: doc.contentHash,
        sectionIndex: 0,
        partIndex: 0,
        sectionTitle: doc.title || "General",
        sectionPath: doc.title ? [doc.title] : [],
        sectionSlug: slugify(doc.title || "general"),
        anchorText: doc.title || "General",
        text,
        textHash: sha256(text),
        statusCode: doc.metadata?.statusCode ?? null,
      },
    ];
  }

  return sections;
}

function pickFactSentence(text, facet) {
  const sentences = text
    .replace(/\n+/gu, " ")
    .split(/(?<=[.?!])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const entry = BAGGAGE_FACETS.find((candidate) => candidate.facet === facet);
  const matches = sentences.filter((sentence) => entry?.pattern.test(sentence));

  if (matches.length) {
    return matches.slice(0, 2).join(" ");
  }

  return sentences.slice(0, 2).join(" ").slice(0, 500).trim();
}

function extractBaggageFacts(doc, sections) {
  if (doc.sourceType !== "airline_policy" || !doc.retrievalAllowed) {
    return [];
  }

  const facts = [];

  for (const section of sections) {
    for (const entry of BAGGAGE_FACETS) {
      const searchable = `${section.sectionTitle}\n${section.text}`;
      if (!entry.pattern.test(searchable)) {
        continue;
      }

      const valueText = pickFactSentence(section.text, entry.facet);
      if (!valueText) {
        continue;
      }

      const factId = hashToUuid(`${section.sectionId}:${entry.facet}`);
      facts.push({
        id: factId,
        factId,
        sectionId: section.sectionId,
        docId: doc.docId,
        url: doc.url,
        canonicalUrl: doc.canonicalUrl,
        title: doc.title,
        sourceType: doc.sourceType,
        airlineName: doc.airlineName,
        facet: entry.facet,
        valueText,
        conditions: null,
        units: null,
        effectiveDate: null,
        retrievalAllowed: doc.retrievalAllowed,
      });
    }
  }

  return Object.values(
    facts.reduce((accumulator, fact) => {
      accumulator[fact.factId] = fact;
      return accumulator;
    }, {}),
  );
}

function parseDirectoryFieldLabel(line) {
  const simplified = trimMarkdownDecorators(line)
    .replace(/:$/u, "")
    .trim()
    .toLowerCase();

  return DIRECTORY_FIELD_KEY_BY_LABEL.get(simplified) || null;
}

function extractInlineAirlineName(line) {
  const match = String(line || "").match(DIRECTORY_ROW_START_PATTERN);
  if (!match) {
    return null;
  }

  const airlineName = trimMarkdownDecorators(match[1]);
  if (!airlineName || DIRECTORY_LABEL_PATTERN.test(airlineName)) {
    return null;
  }

  return airlineName;
}

function dedupeFieldLines(lines) {
  const seen = new Set();
  const deduped = [];

  for (const line of lines) {
    const normalized = normalizeText(line)
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(" ");
    const key = normalized.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(line.trim());
  }

  return deduped;
}

function simplifyFieldLines(lines) {
  return dedupeFieldLines(lines)
    .map((line) => trimMarkdownDecorators(line))
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

function firstUniqueUrl(lines) {
  return [...new Set(lines.flatMap((line) => markdownLinks(line)))][0] || null;
}

function extractCarryOnDetails(lines) {
  const simplified = simplifyFieldLines(lines);
  const detailMap = new Map();

  for (const line of simplified) {
    const match = line.match(/^(Cost|Weight|Size|Notes)\s*:\s*(.+)$/iu);
    if (!match) {
      continue;
    }

    const key = match[1].toLowerCase();
    if (!detailMap.has(key)) {
      detailMap.set(key, match[2].trim());
    }
  }

  return {
    cost: detailMap.get("cost") || null,
    weight: detailMap.get("weight") || null,
    size: detailMap.get("size") || null,
    notes: detailMap.get("notes") || null,
  };
}

function buildDirectoryRowTexts({
  airlineName,
  routeScope,
  carryOnText,
  carryOnCost,
  carryOnWeight,
  carryOnSize,
  carryOnNotes,
  firstBagUrl,
  secondBagUrl,
  additionalPolicyUrl,
}) {
  const rowLines = [
    `Airline: ${airlineName}`,
    routeScope ? `Destinations: ${routeScope}` : null,
    carryOnText && !carryOnCost && !carryOnWeight && !carryOnSize && !carryOnNotes
      ? `CarryOn: ${carryOnText}`
      : "CarryOn:",
    carryOnCost ? `**Cost:** ${carryOnCost}` : null,
    carryOnCost ? `Cost: ${carryOnCost}` : null,
    carryOnWeight ? `**Weight:** ${carryOnWeight}` : null,
    carryOnWeight ? `Weight: ${carryOnWeight}` : null,
    carryOnSize ? `**Size:** ${carryOnSize}` : null,
    carryOnSize ? `Size: ${carryOnSize}` : null,
    carryOnNotes ? `**Notes:** ${carryOnNotes}` : null,
    carryOnNotes ? `Notes: ${carryOnNotes}` : null,
    firstBagUrl ? `1st Bag Policy: ${firstBagUrl}` : null,
    secondBagUrl ? `2nd Bag Policy: ${secondBagUrl}` : null,
    additionalPolicyUrl ? `Additional Policy: ${additionalPolicyUrl}` : null,
  ].filter(Boolean);

  const embeddingLines = [
    `Airline: ${airlineName}`,
    routeScope ? `Destinations: ${routeScope}` : null,
    carryOnText ? `CarryOn: ${carryOnText}` : "CarryOn: View policy",
    carryOnCost ? `CarryOn Cost: ${carryOnCost}` : null,
    carryOnWeight ? `CarryOn Weight: ${carryOnWeight}` : null,
    carryOnSize ? `CarryOn Size: ${carryOnSize}` : null,
    carryOnNotes ? `CarryOn Notes: ${carryOnNotes}` : null,
    firstBagUrl ? `1st Bag Policy: ${firstBagUrl}` : null,
    secondBagUrl ? `2nd Bag Policy: ${secondBagUrl}` : null,
    additionalPolicyUrl ? `Additional Policy: ${additionalPolicyUrl}` : null,
  ].filter(Boolean);

  return {
    rowText: rowLines.join("\n"),
    embeddingText: embeddingLines.join("\n"),
  };
}

function buildDirectoryRowRecord(doc, row, rowIndex) {
  const routeScope = simplifyFieldLines(row.fields.destinations).join(" ").trim() || null;
  const carryOnLines = dedupeFieldLines(row.fields.carryOn);
  const carryOnSimple = simplifyFieldLines(carryOnLines);
  const carryOnText = carryOnSimple.join(" ").trim() || null;
  const carryOnDetails = extractCarryOnDetails(carryOnLines);
  const firstBagUrl = firstUniqueUrl(row.fields.firstBag);
  const secondBagUrl = firstUniqueUrl(row.fields.secondBag);
  const additionalPolicyUrl = firstUniqueUrl(row.fields.additionalPolicy);
  const { rowText, embeddingText } = buildDirectoryRowTexts({
    airlineName: row.airlineName,
    routeScope,
    carryOnText,
    carryOnCost: carryOnDetails.cost,
    carryOnWeight: carryOnDetails.weight,
    carryOnSize: carryOnDetails.size,
    carryOnNotes: carryOnDetails.notes,
    firstBagUrl,
    secondBagUrl,
    additionalPolicyUrl,
  });
  const routeSlug = slugify(routeScope || `row-${rowIndex}`) || `row-${rowIndex}`;
  const rowId = hashToUuid(
    `${doc.docId}:row:${row.airlineSlug}:${routeSlug}:${rowIndex}`,
  );

  return {
    id: rowId,
    rowId,
    sectionId: rowId,
    docId: doc.docId,
    url: doc.url,
    canonicalUrl: doc.canonicalUrl,
    redirectedUrl: doc.redirectedUrl,
    domain: getDomain(doc.canonicalUrl || doc.url),
    title: doc.title,
    airlineName: row.airlineName,
    airlineSlug: row.airlineSlug,
    sourceUrl: doc.url,
    sourceType: "baggage_directory_row",
    authority: doc.authority,
    qualityStatus: doc.qualityStatus,
    retrievalAllowed: doc.retrievalAllowed,
    fetchedAt: doc.fetchedAt,
    contentHash: doc.contentHash,
    chunkIndex: rowIndex,
    sectionIndex: rowIndex,
    partIndex: 0,
    sectionTitle: row.airlineName,
    sectionPath: [doc.title || "Baggage Fees", row.airlineName, routeScope].filter(
      Boolean,
    ),
    sectionSlug: row.airlineSlug,
    anchorText: row.airlineName,
    routeScope,
    carryOnText,
    carryOnCost: carryOnDetails.cost,
    carryOnWeight: carryOnDetails.weight,
    carryOnSize: carryOnDetails.size,
    carryOnNotes: carryOnDetails.notes,
    firstBagUrl,
    secondBagUrl,
    additionalPolicyUrl,
    rowText,
    embeddingText,
    text: rowText,
    textHash: sha256(rowText),
  };
}

function extractBaggageDirectoryRows(doc) {
  if (doc.sourceType !== "baggage_directory" || !doc.retrievalAllowed) {
    return [];
  }

  const lines = normalizeText(doc.cleanedText).split("\n");
  const rows = [];
  let current = null;
  let currentField = null;

  function flushCurrent() {
    if (!current) {
      return;
    }

    rows.push(
      buildDirectoryRowRecord(doc, current, rows.length),
    );
    current = null;
    currentField = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const airlineName = extractInlineAirlineName(line);

    if (airlineName) {
      flushCurrent();
      current = {
        airlineName,
        airlineSlug: slugify(airlineName),
        fields: {
          destinations: [],
          carryOn: [],
          firstBag: [],
          secondBag: [],
          additionalPolicy: [],
        },
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const field = parseDirectoryFieldLabel(line);
    if (field) {
      currentField = field;
      continue;
    }

    if (!line.trim() || !currentField) {
      continue;
    }

    current.fields[currentField].push(line);
  }

  flushCurrent();

  return rows.filter(
    (row) =>
      row.airlineName &&
      (row.routeScope || row.carryOnText || row.firstBagUrl || row.additionalPolicyUrl),
  );
}

function extractAirlineRegistry(doc) {
  if (doc.sourceType === "airline_policy" && doc.airlineName) {
    const registryId = hashToUuid(`${doc.docId}:registry:${doc.airlineSlug}`);
    return [
      {
        id: registryId,
        registryId,
        docId: doc.docId,
        airlineName: doc.airlineName,
        airlineSlug: doc.airlineSlug,
        sourceUrl: doc.url,
        canonicalUrl: doc.canonicalUrl,
        rowText: doc.title,
        policyUrls: [doc.canonicalUrl || doc.url],
        crawlStatus: doc.qualityStatus,
      },
    ];
  }

  if (doc.sourceType !== "baggage_directory") {
    return [];
  }

  return extractBaggageDirectoryRows(doc)
    .map((row) => {
      const policyUrls = [
        row.firstBagUrl,
        row.secondBagUrl,
        row.additionalPolicyUrl,
      ].filter(Boolean);

      return {
        id: hashToUuid(`${doc.docId}:registry:${row.airlineSlug}:${slugify(row.routeScope || row.rowId)}`),
        registryId: hashToUuid(
          `${doc.docId}:registry:${row.airlineSlug}:${slugify(row.routeScope || row.rowId)}`,
        ),
        docId: doc.docId,
        airlineName: row.airlineName,
        airlineSlug: row.airlineSlug,
        sourceUrl: doc.url,
        canonicalUrl: doc.canonicalUrl,
        rowText: row.rowText,
        policyUrls: [...new Set(policyUrls)],
        crawlStatus: "discovered",
      };
    })
    .filter((entry) => entry.policyUrls.length);
}

function buildHybridArtifacts(rawDoc, options = {}) {
  const document = normalizeDocument(rawDoc, options);
  const sections = buildSections(document, options);
  const directoryRows = extractBaggageDirectoryRows(document);
  const airlineRegistry = extractAirlineRegistry(document);
  const facts = extractBaggageFacts(document, sections);

  return {
    document,
    sections,
    directoryRows,
    airlineRegistry,
    facts,
  };
}

export { deriveAirlineName, normalizeDocument, buildSections, extractBaggageFacts, extractBaggageDirectoryRows, extractAirlineRegistry, buildHybridArtifacts };
