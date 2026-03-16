const __queryRoutingModule = (() => {
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "by",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "the",
  "to",
  "us",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
]);

const GENERIC_AIRLINE_WORDS = new Set([
  "air",
  "airline",
  "airlines",
  "airways",
  "line",
  "lines",
]);

const NON_AIRLINE_TOKENS = new Set([
  "additional",
  "allowance",
  "allowances",
  "bag",
  "baggage",
  "bags",
  "carry",
  "checked",
  "cost",
  "costs",
  "faq",
  "faqs",
  "fee",
  "fees",
  "guide",
  "hand",
  "help",
  "info",
  "information",
  "limit",
  "limits",
  "luggage",
  "personal",
  "policy",
  "rules",
  "size",
  "special",
  "travel",
  "welcome",
  "weight",
]);

const PRIVACY_ASPECT_PATTERNS = [
  {
    aspect: "collect",
    pattern:
      /\b(collect|collects|collection|gather|gathers|obtain|obtains|personal information may collect)\b/iu,
  },
  {
    aspect: "use",
    pattern:
      /\b(use|uses|used|usage|process(?:es|ing)?|fulfill|booking|payment|payments)\b/iu,
  },
  {
    aspect: "disclose",
    pattern:
      /\b(disclose|disclosed|disclosure|transfer|transferred|share|shared)\b/iu,
  },
  {
    aspect: "security",
    pattern:
      /\b(security|secure|protection|protect|protected|guarantee|guaranteed)\b/iu,
  },
  {
    aspect: "retention",
    pattern:
      /\b(retention|retain|retained|retaining|storage period|retention period)\b/iu,
  },
];

const ROUTE_SCOPE_TOKENS = [
  "usa",
  "canada",
  "domestic",
  "international",
  "within",
  "between",
  "except",
  "from",
  "to",
];

const BAGGAGE_FACETS = [
  {
    facet: "carry_on",
    pattern:
      /\b(carry[\s-]?on|cabin bag(?:gage)?|hand bag(?:gage)?|personal item)\b/iu,
  },
  {
    facet: "first_checked_bag",
    pattern:
      /\b(first checked bag|1st bag|first bag|checked bag(?: allowance)?|checked baggage)\b/iu,
  },
  {
    facet: "second_checked_bag",
    pattern: /\b(second checked bag|2nd bag|second bag)\b/iu,
  },
  {
    facet: "oversize",
    pattern: /\b(oversize|oversized|size limit|dimension(?:s)? limit)\b/iu,
  },
  {
    facet: "overweight",
    pattern: /\b(overweight|weight limit|weight allowance)\b/iu,
  },
  {
    facet: "special_items",
    pattern: /\b(special item|sporting equipment|musical instrument)\b/iu,
  },
  {
    facet: "additional_policy",
    pattern: /\b(additional policy|policy|allowance|fees?)\b/iu,
  },
];

function normalizeForSearch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function tokenize(value) {
  return normalizeForSearch(value)
    .split(/\s+/u)
    .filter(Boolean);
}

function isUsefulAirlineAlias(alias) {
  const tokens = tokenize(alias);
  if (!tokens.length) {
    return false;
  }

  const meaningful = tokens.filter(
    (token) =>
      !STOP_WORDS.has(token) &&
      !NON_AIRLINE_TOKENS.has(token) &&
      !GENERIC_AIRLINE_WORDS.has(token),
  );

  return meaningful.length > 0;
}

function detectFacet(query) {
  for (const entry of BAGGAGE_FACETS) {
    if (entry.pattern.test(query)) {
      return entry.facet;
    }
  }

  return null;
}

function detectPrivacyAspects(query) {
  const aspects = [];

  for (const entry of PRIVACY_ASPECT_PATTERNS) {
    if (entry.pattern.test(query)) {
      aspects.push(entry.aspect);
    }
  }

  return [...new Set(aspects)];
}

function isComparisonQuery(query) {
  return /\b(compare|comparison|versus|vs\.?|difference|different)\b/iu.test(
    query,
  );
}

function detectRouteScopeHints(query) {
  const tokens = tokenize(query);
  return [...new Set(tokens.filter((token) => ROUTE_SCOPE_TOKENS.includes(token)))];
}

function makeAirlineAliases(name) {
  const normalized = normalizeForSearch(name);
  if (!normalized) {
    return [];
  }

  const tokens = tokenize(normalized);
  const condensed = tokens.filter((token) => !GENERIC_AIRLINE_WORDS.has(token));
  const aliases = new Set([normalized]);

  if (condensed.length) {
    aliases.add(condensed.join(" "));
    aliases.add(condensed[0]);
  }

  if (condensed.length > 1) {
    aliases.add(condensed.slice(0, 2).join(" "));
  }

  return [...aliases].filter((alias) => alias.length >= 3);
}

function isLikelyAirlineName(name) {
  const tokens = tokenize(name);
  if (!tokens.length) {
    return false;
  }

  const meaningful = tokens.filter((token) => !NON_AIRLINE_TOKENS.has(token));
  if (!meaningful.length) {
    return false;
  }

  if (
    meaningful.length === 1 &&
    !GENERIC_AIRLINE_WORDS.has(meaningful[0]) &&
    tokens.length <= 2 &&
    tokens.some((token) => NON_AIRLINE_TOKENS.has(token))
  ) {
    return false;
  }

  return true;
}

function hasPhrase(query, phrase) {
  return new RegExp(`(^|\\s)${phrase.replace(/\s+/gu, "\\s+")}(\\s|$)`, "u").test(
    query,
  );
}

function matchAirlines(query, airlines) {
  const normalizedQuery = normalizeForSearch(query);
  const matches = [];

  for (const airline of airlines) {
    const airlineName = airline.airlineName || airline.airline_name;
    const airlineSlug = airline.airlineSlug || airline.airline_slug;
    if (!isLikelyAirlineName(airlineName)) {
      continue;
    }

    const aliases = new Set(makeAirlineAliases(airlineName));

    if (airlineSlug) {
      aliases.add(normalizeForSearch(airlineSlug));
      aliases.add(normalizeForSearch(airlineSlug).replace(/-/gu, " "));
    }

    let bestAlias = null;

    for (const alias of aliases) {
      if (!isUsefulAirlineAlias(alias)) {
        continue;
      }

      if (hasPhrase(normalizedQuery, alias)) {
        if (!bestAlias || alias.length > bestAlias.length) {
          bestAlias = alias;
        }
      }
    }

    if (bestAlias) {
      matches.push({
        airlineName,
        airlineSlug,
        matchedAlias: bestAlias,
        score: bestAlias.length,
      });
    }
  }

  return matches.sort((left, right) => right.score - left.score);
}

function buildFtsQuery(query) {
  const tokens = tokenize(query)
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token));

  const unique = [...new Set(tokens)].slice(0, 10);
  if (!unique.length) {
    return null;
  }

  return unique.map((token) => `${token}*`).join(" OR ");
}

  return { BAGGAGE_FACETS, normalizeForSearch, detectFacet, detectPrivacyAspects, isComparisonQuery, detectRouteScopeHints, makeAirlineAliases, isLikelyAirlineName, matchAirlines, buildFtsQuery };
})();

const __retrievalServiceModule = (() => {
const { detectFacet, detectPrivacyAspects, detectRouteScopeHints, isComparisonQuery, matchAirlines, normalizeForSearch } = __queryRoutingModule;

const RRF_K = 60;
const DIRECTORY_QUERY_HINT_PATTERN =
  /\b(according to (the )?cheapoair baggage fees page|cheapoair baggage fees page|on the cheapoair baggage fees page)\b/iu;
const DIRECTORY_FIELD_INTENTS = [
  { field: "cost", pattern: /\b(cost|price|free)\b/iu },
  { field: "weight", pattern: /\bweight\b/iu },
  { field: "size", pattern: /\b(size|dimension|dimensions)\b/iu },
  { field: "notes", pattern: /\b(note|notes|personal item)\b/iu },
];
const DIRECTORY_LINKED_POLICY_FACETS = [
  {
    facet: "first_checked_bag",
    urlField: "firstBagUrl",
    label: "1st bag",
    pattern: /\b(first checked bag|1st bag|first bag|checked bag)\b/iu,
  },
  {
    facet: "second_checked_bag",
    urlField: "secondBagUrl",
    label: "2nd bag",
    pattern: /\b(second checked bag|2nd bag|second bag)\b/iu,
  },
  {
    facet: "additional_policy",
    urlField: "additionalPolicyUrl",
    label: "additional policy",
    pattern:
      /\b(additional policy|special item|special items|sporting equipment|musical instrument)\b/iu,
  },
];
const PRIVACY_ASPECT_LABELS = {
  collect: "what personal information is collected",
  use: "how personal information may be used",
  disclose: "how personal information may be disclosed",
  security: "security limitations and safeguards",
  retention: "retention period and retention rules",
};
const PRIVACY_TOPIC_DEFINITIONS = [
  {
    topic: "introduction",
    queryPattern: /\b(who owns|who operates|owner|operator|fareportal)\b/iu,
    sectionPattern: /\bintroduction\b/iu,
    textPattern: /\bfareportal\b/iu,
  },
  {
    topic: "collect",
    queryPattern:
      /\b(collect|collects|collection|what information|personal information may collect)\b/iu,
    sectionPattern: /\b(personal information we may collect|personal information)\b/iu,
    textPattern:
      /\b(personal information we may collect|name|email|telephone number|credit and debit card|passport number|payment)\b/iu,
  },
  {
    topic: "use",
    queryPattern:
      /\b(use|uses|used|booking|bookings|payment|payments|fulfill|process)\b/iu,
    sectionPattern: /\bhow we may use personal information\b/iu,
    textPattern:
      /\b(how we may use personal information|complete and fulfill your booking|process your payment)\b/iu,
  },
  {
    topic: "disclose",
    queryPattern:
      /\b(disclose|disclosed|disclosure|share|shared|transfer|transferred)\b/iu,
    sectionPattern: /\bhow personal information may be disclosed\b/iu,
    textPattern:
      /\b(how personal information may be disclosed|disclosed or transferred)\b/iu,
  },
  {
    topic: "analytics",
    queryPattern:
      /\b(analytics|advertising data|automatically collect|browser|device)\b/iu,
    sectionPattern: /\b(analytics advertising data|personal information)\b/iu,
    textPattern: /\b(analytics\/advertising data|automatically collect)\b/iu,
  },
  {
    topic: "third_party",
    queryPattern: /\b(third[- ]party|third parties)\b/iu,
    sectionPattern: /\bthird-?party services\b/iu,
    textPattern: /\b(not responsible|third parties)\b/iu,
    requireSectionTitle: true,
  },
  {
    topic: "advertising",
    queryPattern:
      /\b(advertising|interest-based advertising|advertising choices|ad choices)\b/iu,
    sectionPattern: /\bmore on advertising\b/iu,
    textPattern:
      /\b(interest-based advertising|network advertising initiative)\b/iu,
    requireSectionTitle: true,
  },
  {
    topic: "security",
    queryPattern:
      /\b(security|secure|guarantee|guaranteed|protect|protection)\b/iu,
    sectionPattern: /\bsecurity\b/iu,
    textPattern:
      /\b(unfortunately|cannot be guaranteed to be secure|guaranteed to be secure)\b/iu,
    requireSectionTitle: true,
  },
  {
    topic: "retention",
    queryPattern:
      /\b(retention|retain|retained|retaining|retention period)\b/iu,
    sectionPattern: /\bretention period\b/iu,
    textPattern:
      /\b(retain your personal information|longer retention period)\b/iu,
    requireSectionTitle: true,
  },
  {
    topic: "opt_out",
    queryPattern: /\b(opt[- ]out|marketing emails?)\b/iu,
    sectionPattern: /\bopt-out of marketing emails\b/iu,
    textPattern: /\b(opt-out|marketing-related emails)\b/iu,
    requireSectionTitle: true,
  },
  {
    topic: "non_us",
    queryPattern: /\b(non[- ]us|outside of the u\.?s\.?)\b/iu,
    sectionPattern:
      /\b(non-us residents|important notice to all non-us residents)\b/iu,
    textPattern:
      /\b(outside of the u\.s\.|transferred from your country of origin)\b/iu,
    requireSectionTitle: true,
  },
  {
    topic: "gdpr",
    queryPattern: /\b(gdpr|european economic area|eea)\b/iu,
    sectionPattern: /\bgdpr notice\b/iu,
    textPattern: /\b(european economic area|gdpr)\b/iu,
    requireSectionTitle: true,
  },
  {
    topic: "state_rights",
    queryPattern:
      /\b(u\.?s\. state|state privacy|california|colorado|virginia)\b/iu,
    sectionPattern: /\bu\.s\. state privacy law rights\b/iu,
    textPattern: /\b(california|colorado|resident)\b/iu,
    requireSectionTitle: true,
  },
  {
    topic: "canada",
    queryPattern: /\b(canada|canadian)\b/iu,
    sectionPattern: /\bcanadian privacy rights\b/iu,
    textPattern: /\b(canada|canadian)\b/iu,
    requireSectionTitle: true,
  },
  {
    topic: "sensitive",
    queryPattern: /\bsensitive\b/iu,
    sectionPattern: /\bsensitive information\b/iu,
    textPattern: /\b(sensitive information|not send us)\b/iu,
    requireSectionTitle: true,
  },
];
const PRIVACY_TOPIC_BY_ID = new Map(
  PRIVACY_TOPIC_DEFINITIONS.map((definition) => [definition.topic, definition]),
);

function uniqueBy(items, selector) {
  const seen = new Set();
  const unique = [];

  for (const item of items) {
    const key = selector(item);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function withCitations(results) {
  return results.map((hit, index) => ({
    citationIndex: index + 1,
    ...hit,
  }));
}

function hitKey(hit) {
  return hit.rowId || hit.sectionId || hit.id;
}

function uniqueTokens(value) {
  return [...new Set(normalizeForSearch(value).split(/\s+/u).filter(Boolean))];
}

function normalizeHit(hit, label) {
  return {
    ...hit,
    sectionId: hit.sectionId || hit.id,
    retrievalStrategy: label === "hyde" ? "hyde" : "vector",
  };
}

function keywordBonus({ query, hit, routedAirlines = [] }) {
  const searchable = normalizeForSearch(
    [
      hit.title,
      hit.sectionTitle,
      hit.text,
      hit.routeScope,
      hit.airlineName,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (!searchable) {
    return 0;
  }

  const tokens = uniqueTokens(query).filter((token) => token.length >= 3);
  let bonus = 0;

  for (const token of tokens) {
    if (searchable.includes(token)) {
      bonus += 0.001;
    }
  }

  for (const airline of routedAirlines) {
    const name = normalizeForSearch(airline.airlineName || "");
    if (name && searchable.includes(name)) {
      bonus += 0.01;
    }
  }

  return bonus;
}

function routeAirlines(query, availableAirlines, filter = {}) {
  if (filter.airline) {
    const matches = matchAirlines(filter.airline, availableAirlines);
    if (matches.length) {
      return matches.slice(0, 3);
    }

    if (availableAirlines.length) {
      return [];
    }

    return [
      {
        airlineName: filter.airline,
        airlineSlug: normalizeForSearch(filter.airline).replace(/\s+/gu, "-"),
      },
    ];
  }

  return matchAirlines(query, availableAirlines).slice(0, 3);
}

function buildVectorFilter(filter = {}, airline = null) {
  return {
    url: filter.url,
    domain: filter.domain,
    sourceType: filter.sourceType,
    airline: airline || filter.airline,
    retrievalAllowed: true,
  };
}

function buildAirlineTargets(filter, routedAirlines) {
  if (filter.airline) {
    return [filter.airline];
  }

  if (!routedAirlines.length) {
    return [null];
  }

  return uniqueBy(
    routedAirlines.map((entry) => entry.airlineName).filter(Boolean),
    (value) => value,
  );
}

function mergeSearchVariants(hit, extraVariants = []) {
  const variants = new Set([...(hit.searchVariants || []), ...extraVariants]);

  return {
    ...hit,
    searchVariants: [...variants].sort(),
  };
}

function mergeFields(target, source) {
  const merged = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (key === "score" || key === "searchVariants") {
      continue;
    }

    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  }

  return merged;
}

function fuseRankedLists({ lists, topK, query, routedAirlines }) {
  const fused = new Map();

  for (const list of lists) {
    const weight = list.weight ?? 1;

    for (let index = 0; index < list.hits.length; index += 1) {
      const hit = list.hits[index];
      const key = hit.sectionId || hit.id;
      if (!key) {
        continue;
      }

      const rrf = weight / (RRF_K + index + 1);
      const existing = fused.get(key);

      if (!existing) {
        fused.set(key, {
          ...hit,
          rawScore: hit.score || 0,
          score: rrf,
          searchVariants: new Set([list.label]),
        });
        continue;
      }

      existing.score += rrf;
      existing.rawScore = Math.max(existing.rawScore, hit.score || 0);
      existing.searchVariants.add(list.label);
      if ((hit.score || 0) >= existing.rawScore) {
        const merged = mergeFields(existing, hit);
        Object.assign(existing, merged);
      }
    }
  }

  return [...fused.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.rawScore - left.rawScore;
    })
    .slice(0, topK)
    .map((hit) => ({
      ...hit,
      score: Number(
        (hit.score + keywordBonus({ query, hit, routedAirlines })).toFixed(6),
      ),
      retrievalStrategy: hit.searchVariants.has("hyde") ? "hyde" : "vector",
      searchVariants: [...hit.searchVariants].sort(),
    }))
    .sort((left, right) => right.score - left.score);
}

function shouldUseDirectoryRowMode(query, filter = {}) {
  return (
    filter.sourceType === "baggage_directory" ||
    filter.sourceType === "baggage_directory_row" ||
    DIRECTORY_QUERY_HINT_PATTERN.test(query)
  );
}

function detectDirectoryFieldIntent(query) {
  for (const entry of DIRECTORY_FIELD_INTENTS) {
    if (entry.pattern.test(query)) {
      return entry.field;
    }
  }

  return null;
}

function detectLinkedPolicyFacetRequests(query) {
  return DIRECTORY_LINKED_POLICY_FACETS.filter((entry) => entry.pattern.test(query));
}

function buildLinkedPolicyQueries(query, row, request) {
  return [
    query,
    `Focus specifically on ${request.label} details for ${row.airlineName}.`,
    row.routeScope ? `Route scope: ${row.routeScope}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildUrlVariants(url) {
  if (!url) {
    return [];
  }

  const variants = new Set();
  const baseVariants = [url];

  if (url.endsWith("/")) {
    baseVariants.push(url.replace(/\/+$/u, ""));
  } else {
    baseVariants.push(`${url}/`);
  }

  for (const candidate of baseVariants) {
    variants.add(candidate);

    if (candidate.startsWith("http://")) {
      variants.add(`https://${candidate.slice("http://".length)}`);
    }
    if (candidate.startsWith("https://")) {
      variants.add(`http://${candidate.slice("https://".length)}`);
    }
  }

  return [...variants];
}

function routeScopeScore(routeHints, row) {
  if (!routeHints.length) {
    return 0;
  }

  const normalizedRoute = normalizeForSearch(row.routeScope || "");
  if (!normalizedRoute) {
    return -0.75;
  }

  let score = 0;

  for (const hint of routeHints) {
    if (normalizedRoute.includes(hint)) {
      score += 1.25;
    }
  }

  return score || -0.75;
}

function facetCompletenessScore(facet, fieldIntent, row) {
  if (fieldIntent === "cost" && row.carryOnCost) {
    return 1.75;
  }

  if (fieldIntent === "weight" && row.carryOnWeight) {
    return 1.75;
  }

  if (fieldIntent === "size" && row.carryOnSize) {
    return 1.75;
  }

  if (fieldIntent === "notes" && row.carryOnNotes) {
    return 1.75;
  }

  switch (facet) {
    case "carry_on":
      return row.carryOnText ? 1.5 : 0;
    case "first_checked_bag":
      return row.firstBagUrl ? 1.5 : 0;
    case "second_checked_bag":
      return row.secondBagUrl ? 1.5 : 0;
    case "oversize":
      return row.carryOnSize ? 1.5 : 0;
    case "overweight":
      return row.carryOnWeight ? 1.5 : 0;
    case "additional_policy":
      return row.additionalPolicyUrl ? 1.5 : 0;
    default:
      return 0;
  }
}

function scoreDirectoryRow({
  row,
  query,
  facet,
  fieldIntent,
  routeHints,
  requestedAirline,
}) {
  const searchable = normalizeForSearch(
    [
      row.airlineName,
      row.routeScope,
      row.rowText,
      row.carryOnText,
      row.carryOnCost,
      row.carryOnWeight,
      row.carryOnSize,
      row.carryOnNotes,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const normalizedAirline = normalizeForSearch(row.airlineName || "");
  const normalizedRequestedAirline = normalizeForSearch(requestedAirline || "");
  let score = 0;

  if (
    normalizedAirline &&
    normalizedRequestedAirline &&
    normalizedAirline === normalizedRequestedAirline
  ) {
    score += 4;
  }

  score += routeScopeScore(routeHints, row);
  score += facetCompletenessScore(facet, fieldIntent, row);

  for (const token of uniqueTokens(query).filter((token) => token.length >= 3)) {
    if (searchable.includes(token)) {
      score += 0.03;
    }
  }

  if (normalizedAirline && searchable.includes(normalizedAirline)) {
    score += 0.5;
  }

  return Number(score.toFixed(6));
}

function formatStructuredRowHit(row, score) {
  return {
    ...row,
    score: Number(score.toFixed(6)),
    retrievalStrategy: "structured",
    searchVariants: ["row"],
  };
}

function selectRowHitsForAirline(rows, { allowAlternateRoute }) {
  if (!rows.length) {
    return [];
  }

  const selected = [rows[0]];
  if (!allowAlternateRoute) {
    return selected;
  }

  const primaryRoute = normalizeForSearch(rows[0].routeScope || "");
  const alternate = rows.find(
    (row) => normalizeForSearch(row.routeScope || "") !== primaryRoute,
  );

  if (alternate) {
    selected.push(alternate);
  }

  return selected;
}

function shouldKeepDirectoryRowFirst({ query, facet, fieldIntent }) {
  return (
    Boolean(fieldIntent) ||
    facet === "carry_on" ||
    /\b(carry[\s-]?on|personal item)\b/iu.test(query)
  );
}

function detectPrivacyTopics(query) {
  const detected = new Set(detectPrivacyAspects(query));

  for (const definition of PRIVACY_TOPIC_DEFINITIONS) {
    if (definition.queryPattern.test(query)) {
      detected.add(definition.topic);
    }
  }

  return [...detected];
}

function matchesPrivacyTopic(hit, definition) {
  const sectionTitle = hit.sectionTitle || "";
  const titleMatch = definition.sectionPattern.test(sectionTitle);

  if (definition.requireSectionTitle) {
    return titleMatch;
  }

  return (
    titleMatch ||
    definition.textPattern.test(hit.text || "")
  );
}

function scorePrivacyTopicCandidate({ candidate, definition, query }) {
  const sectionTitle = candidate.sectionTitle || "";
  const sectionText = [sectionTitle, ...(candidate.sectionPath || []), candidate.title]
    .filter(Boolean)
    .join("\n");
  const searchable = normalizeForSearch(
    [sectionText, candidate.text].filter(Boolean).join("\n"),
  );
  const titleMatch = definition.sectionPattern.test(sectionTitle);
  let score = 0;

  if (titleMatch) {
    score += 6;
  } else if (definition.sectionPattern.test(sectionText)) {
    score += 2;
  }

  if (definition.requireSectionTitle && !titleMatch) {
    return 0;
  }

  if (definition.textPattern.test(candidate.text || "")) {
    score += 3;
  }

  for (const token of uniqueTokens(query).filter((token) => token.length >= 3)) {
    if (searchable.includes(token)) {
      score += 0.03;
    }
  }

  if (
    (definition.topic === "collect" || definition.topic === "use") &&
    (candidate.sectionPath || []).includes("PERSONAL INFORMATION")
  ) {
    score += 0.5;
  }

  return Number(score.toFixed(6));
}

class RetrievalService {
  constructor({ config, openAiService, qdrantService }) {
    this.config = config;
    this.openAiService = openAiService;
    this.qdrantService = qdrantService;
  }

  async buildSearchPlans({ query, filter, routedAirlines = [] }) {
    const plans = [
      {
        label: "query",
        text: query,
        weight: 1,
      },
    ];

    if (routedAirlines.length) {
      for (const airline of routedAirlines) {
        const airlineName = airline.airlineName;
        if (!airlineName) {
          continue;
        }

        plans.push({
          label: `airline:${airlineName}`,
          text: [airlineName, filter.facet || "", query].filter(Boolean).join("\n"),
          weight: 1.1,
        });
      }
    }

    const hydeRequests = [
      {
        label: "hyde",
        weight: 1.25,
        filter,
        query,
      },
    ];
    const privacyAspects =
      filter.sourceType === "privacy_policy"
        ? detectPrivacyAspects(query)
        : [];

    if (privacyAspects.length > 1) {
      for (const aspect of privacyAspects) {
        hydeRequests.push({
          label: `hyde:${aspect}`,
          weight: 1.12,
          filter: {
            ...filter,
            privacyAspect: aspect,
          },
          query: [
            query,
            `Focus specifically on ${PRIVACY_ASPECT_LABELS[aspect] || aspect}.`,
          ].join("\n"),
        });
      }
    }

    const hypotheticalPassages = await Promise.all(
      hydeRequests.map((request) =>
        this.openAiService.generateHypotheticalDocument({
          query: request.query,
          filter: request.filter,
        }),
      ),
    );

    hypotheticalPassages.forEach((hypothetical, index) => {
      if (!hypothetical) {
        return;
      }

      const request = hydeRequests[index];
      plans.unshift({
        label: request.label,
        text: hypothetical,
        weight: request.weight,
      });
    });

    const vectors = await this.openAiService.createEmbeddings(
      plans.map((plan) => plan.text),
    );

    return plans.map((plan, index) => ({
      ...plan,
      vector: vectors[index],
    }));
  }

  async retrieveVectorHits(query, { topK, filter, routedAirlines = [] }) {
    const searchPlans = await this.buildSearchPlans({
      query,
      filter,
      routedAirlines,
    });
    const airlineTargets = buildAirlineTargets(filter, routedAirlines);
    const perQueryTopK =
      airlineTargets.length > 1
        ? Math.max(3, Math.ceil(topK / airlineTargets.length) + 1)
        : topK;
    const resultLists = [];

    for (const plan of searchPlans) {
      for (const airline of airlineTargets) {
        const hits = await this.qdrantService.query({
          vector: plan.vector,
          topK: perQueryTopK,
          filter: buildVectorFilter(filter, airline),
        });

        resultLists.push({
          label: plan.label,
          weight: plan.weight,
          hits: hits.map((hit) => normalizeHit(hit, plan.label)),
        });
      }
    }

    return fuseRankedLists({
      lists: resultLists,
      topK,
      query,
      routedAirlines,
    });
  }

  async retrieveDirectoryRows({
    query,
    topK,
    filter,
    facet,
    routedAirlines,
  }) {
    const comparison = isComparisonQuery(query);
    const routeHints = detectRouteScopeHints(query);
    const fieldIntent = detectDirectoryFieldIntent(query);
    const airlineTargets = buildAirlineTargets(filter, routedAirlines).filter(Boolean);
    const exactHits = [];

    for (const airline of airlineTargets) {
      const rows = await this.qdrantService.listDirectoryRows({
        airline,
      });
      const scored = rows
        .map((row) => ({
          row,
          score: scoreDirectoryRow({
            row,
            query,
            facet,
            fieldIntent,
            routeHints,
            requestedAirline: airline,
          }),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .map((entry) => formatStructuredRowHit(entry.row, entry.score));

      exactHits.push(
        ...selectRowHitsForAirline(scored, {
          allowAlternateRoute:
            !comparison &&
            !routeHints.length &&
            (airlineTargets.length <= 1),
        }),
      );
    }

    const uniqueExactHits = uniqueBy(
      exactHits,
      (hit) => hit.rowId || hit.sectionId || hit.id,
    ).slice(0, topK);
    const exactEnough =
      uniqueExactHits.length >=
      (comparison ? Math.max(2, airlineTargets.length) : 1);
    const expandedExactHits = await this.expandDirectoryRowsWithLinkedPolicy({
      query,
      topK,
      facet,
      fieldIntent,
      rowHits: uniqueExactHits,
    });

    if (exactEnough) {
      return withCitations(expandedExactHits);
    }

    const vectorRowHits = await this.retrieveVectorHits(query, {
      topK,
      filter: {
        ...filter,
        sourceType: "baggage_directory_row",
        facet,
      },
      routedAirlines,
    });
    const mergedRowHits = uniqueBy(
      [...uniqueExactHits, ...vectorRowHits],
      (hit) => hit.rowId || hit.sectionId || hit.id,
    ).slice(0, topK);
    const expandedMergedRowHits = await this.expandDirectoryRowsWithLinkedPolicy({
      query,
      topK,
      facet,
      fieldIntent,
      rowHits: mergedRowHits,
    });

    if (
      expandedMergedRowHits.length >=
      (comparison ? Math.max(2, airlineTargets.length) : 1)
    ) {
      return withCitations(expandedMergedRowHits);
    }

    const fallbackHits = await this.retrieveVectorHits(query, {
      topK,
      filter: {
        ...filter,
        sourceType: "baggage_directory",
        facet,
      },
      routedAirlines: [],
    });

    return withCitations(
      uniqueBy(
        [...expandedMergedRowHits, ...fallbackHits],
        (hit) => hitKey(hit),
      ).slice(0, topK),
    );
  }

  async fetchLinkedPolicyHit({ query, row, request }) {
    const focusedQuery = buildLinkedPolicyQueries(query, row, request);

    for (const url of buildUrlVariants(row[request.urlField])) {
      const linkedHits = await this.retrieveVectorHits(focusedQuery, {
        topK: 1,
        filter: {
          sourceType: "airline_policy",
          facet: request.facet,
          url,
        },
        routedAirlines: [],
      });

      if (linkedHits.length) {
        return mergeSearchVariants(
          {
            ...linkedHits[0],
            linkedPolicyFacet: request.facet,
            linkedPolicyUrl: row[request.urlField] || null,
            linkedFromRowId: row.rowId || null,
          },
          [`linked-policy:${request.facet}`],
        );
      }
    }

    if (!row.airlineName) {
      return null;
    }

    const fallbackHits = await this.retrieveVectorHits(focusedQuery, {
      topK: 1,
      filter: {
        sourceType: "airline_policy",
        facet: request.facet,
        airline: row.airlineName,
      },
      routedAirlines: [],
    });

    if (!fallbackHits.length) {
      return null;
    }

    return mergeSearchVariants(
      {
        ...fallbackHits[0],
        linkedPolicyFacet: request.facet,
        linkedPolicyUrl: row[request.urlField] || null,
        linkedFromRowId: row.rowId || null,
      },
      [`linked-policy:${request.facet}`],
    );
  }

  async expandDirectoryRowsWithLinkedPolicy({
    query,
    topK,
    facet,
    fieldIntent,
    rowHits,
  }) {
    const requests = detectLinkedPolicyFacetRequests(query);
    if (!requests.length || !rowHits.length) {
      return rowHits;
    }

    const linkedPolicyHits = [];

    for (const row of rowHits.filter((hit) => hit.sourceType === "baggage_directory_row")) {
      for (const request of requests) {
        const hit = await this.fetchLinkedPolicyHit({
          query,
          row,
          request,
        });

        if (hit) {
          linkedPolicyHits.push(hit);
        }
      }
    }

    if (!linkedPolicyHits.length) {
      return rowHits;
    }

    const ordered = shouldKeepDirectoryRowFirst({ query, facet, fieldIntent })
      ? [...rowHits, ...linkedPolicyHits]
      : [...linkedPolicyHits, ...rowHits];

    return uniqueBy(ordered, (hit) => hitKey(hit)).slice(0, topK);
  }

  async ensurePrivacyTopicCoverage({ query, topK, filter, hits }) {
    const topics = detectPrivacyTopics(query)
      .map((topic) => PRIVACY_TOPIC_BY_ID.get(topic))
      .filter(Boolean);

    if (topics.length <= 1 || typeof this.qdrantService.scrollPoints !== "function") {
      return hits;
    }

    const points = await this.qdrantService.scrollPoints({
      filter: {
        ...filter,
        sourceType: "privacy_policy",
        retrievalAllowed: true,
      },
      limit: 256,
      withPayload: true,
      withVector: false,
    });

    if (!points.length) {
      return hits;
    }

    const candidates = points.map((point) => ({
      id: point.id,
      score: point.score || 0,
      ...point.payload,
      sectionId: point.payload?.sectionId || point.id,
      retrievalStrategy: "hyde",
      searchVariants: ["hyde", "privacy-topic"],
    }));
    const selected = [];
    const used = new Set();

    for (const definition of topics) {
      const existing = hits.find(
        (hit) => !used.has(hitKey(hit)) && matchesPrivacyTopic(hit, definition),
      );

      if (existing) {
        selected.push(
          mergeSearchVariants(existing, [`privacy-topic:${definition.topic}`]),
        );
        used.add(hitKey(existing));
        continue;
      }

      const candidate = candidates
        .map((entry) => ({
          entry,
          score: scorePrivacyTopicCandidate({
            candidate: entry,
            definition,
            query,
          }),
        }))
        .filter(({ score, entry }) => score > 0 && !used.has(hitKey(entry)))
        .sort((left, right) => right.score - left.score)[0];

      if (!candidate) {
        continue;
      }

      selected.push({
        ...candidate.entry,
        score:
          candidate.entry.score ||
          Math.max(0.0001, (hits.at(-1)?.score || 0.01) - selected.length * 0.0001),
        searchVariants: ["hyde", `privacy-topic:${definition.topic}`],
      });
      used.add(hitKey(candidate.entry));
    }

    for (const hit of hits) {
      if (used.has(hitKey(hit))) {
        continue;
      }

      selected.push(hit);
    }

    return uniqueBy(selected, (hit) => hitKey(hit)).slice(0, topK);
  }

  async retrieve(query, options = {}) {
    if (!query?.trim()) {
      throw new Error("A non-empty query is required.");
    }

    if (!this.openAiService.hasEmbeddingSupport()) {
      throw new Error(
        "Vector retrieval requires OPENAI_API_KEY to generate embeddings.",
      );
    }

    if (!this.openAiService.hasChatSupport()) {
      throw new Error(
        "HyDE retrieval requires OPENAI_API_KEY to generate hypothetical passages.",
      );
    }

    const topK = options.topK || this.config.defaultTopK;
    const filter = options.filter || {};
    const facet = filter.facet || detectFacet(query);
    const directoryMode = shouldUseDirectoryRowMode(query, filter);
    const airlineSourceType =
      directoryMode || filter.sourceType === "baggage_directory_row"
        ? "baggage_directory_row"
        : "airline_policy";
    const availableAirlines =
      directoryMode ||
      filter.sourceType === "baggage_directory_row" ||
      filter.sourceType === "airline_policy" ||
      filter.airline
        ? await this.qdrantService.listAirlines({
            sourceType: airlineSourceType,
          })
        : [];
    const routedAirlines = routeAirlines(query, availableAirlines, filter);

    if (filter.airline && availableAirlines.length && !routedAirlines.length) {
      return [];
    }

    if (directoryMode) {
      return this.retrieveDirectoryRows({
        query,
        topK,
        filter,
        facet,
        routedAirlines,
      });
    }

    const hits = await this.retrieveVectorHits(query, {
      topK,
      filter: {
        ...filter,
        facet,
      },
      routedAirlines,
    });
    const finalHits =
      filter.sourceType === "privacy_policy"
        ? await this.ensurePrivacyTopicCoverage({
            query,
            topK,
            filter,
            hits,
          })
        : hits;

    return withCitations(finalHits);
  }
}

  return { RetrievalService };
})();

export const { BAGGAGE_FACETS, normalizeForSearch, detectFacet, detectPrivacyAspects, isComparisonQuery, detectRouteScopeHints, makeAirlineAliases, isLikelyAirlineName, matchAirlines, buildFtsQuery } = __queryRoutingModule;
export const { RetrievalService } = __retrievalServiceModule;
