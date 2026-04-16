import {
  detectPrivacyAspects,
  detectRouteScopeHints,
  isComparisonQuery,
  matchAirlines,
  normalizeForSearch,
} from "./query-routing.js";

const RRF_K = 60;
const DIRECTORY_QUERY_HINT_PATTERN =
  /\b(according to (the )?cheapoair baggage fees page|cheapoair baggage fees page|on the cheapoair baggage fees page)\b/iu;
const NATURAL_BAGGAGE_QUERY_PATTERN =
  /\b(baggage policy|bag(?:gage)? rules|bag(?:gage)? allowance|carry[\s-]?on|cabin bag(?:gage)?|hand bag(?:gage)?|checked bag(?:gage)?|luggage)\b/iu;
const FULL_BAGGAGE_POLICY_PATTERN =
  /\b(baggage policy|bag(?:gage)? policy|bag(?:gage)? rules|bag(?:gage)? allowance|checked baggage policy|checked bag policy)\b/iu;
const USA_LOCATION_PATTERN =
  /\b(usa|u\.?s\.?a?\.?|united states|nyc|new york|jfk|lax|los angeles|atl|atlanta|san francisco|sfo|newark|ewr|boston|bos|dallas|chicago|las vegas|seattle|denver|miami|orlando|hawaii|honolulu|maui|anchorage|juneau)\b/iu;
const CANADA_LOCATION_PATTERN =
  /\b(canada|toronto|vancouver|calgary|montreal|ottawa)\b/iu;
const MEXICO_LOCATION_PATTERN =
  /\b(mexico|mexico city|cancun|guadalajara|monterrey)\b/iu;
const BRAZIL_LOCATION_PATTERN =
  /\b(brazil|sao paulo|rio|rio de janeiro)\b/iu;
const FRANCE_LOCATION_PATTERN =
  /\b(france|paris)\b/iu;
const UNITED_ARAB_EMIRATES_LOCATION_PATTERN =
  /\b(uae|united arab emirates|dubai|abu dhabi)\b/iu;
const GERMANY_LOCATION_PATTERN =
  /\b(germany|frankfurt|munich|berlin)\b/iu;
const NETHERLANDS_LOCATION_PATTERN =
  /\b(netherlands|amsterdam)\b/iu;
const TURKEY_LOCATION_PATTERN =
  /\b(turkey|istanbul)\b/iu;
const QATAR_LOCATION_PATTERN =
  /\b(qatar|doha)\b/iu;
const UNITED_KINGDOM_LOCATION_PATTERN =
  /\b(united kingdom|uk|london|heathrow|gatwick)\b/iu;
const INDIA_LOCATION_PATTERN =
  /\b(india|delhi|mumbai|bengaluru|bangalore)\b/iu;
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
    pattern:
      /\b(first checked bags?|1st bags?|first bags?|checked bags?|bag(?:gage)? fees?|bag prices?)\b/iu,
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

function traceStep(trace, stage, details = {}) {
  if (!Array.isArray(trace)) {
    return;
  }

  trace.push({
    at: new Date().toISOString(),
    stage,
    ...details,
  });
}

function summarizeTraceHit(hit) {
  return {
    id: hitKey(hit) || null,
    sourceType: hit.sourceType || null,
    title: hit.title || null,
    sectionTitle: hit.sectionTitle || null,
    airlineName: hit.airlineName || null,
    routeScope: hit.routeScope || null,
    url: hit.url || null,
    score: hit.score ?? null,
    retrievalStrategy: hit.retrievalStrategy || null,
  };
}

function summarizeTraceHits(hits = [], limit = 3) {
  return hits.slice(0, limit).map((hit) => summarizeTraceHit(hit));
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
  if (
    filter.sourceType &&
    filter.sourceType !== "baggage_directory" &&
    filter.sourceType !== "baggage_directory_row"
  ) {
    return false;
  }

  return (
    filter.sourceType === "baggage_directory" ||
    filter.sourceType === "baggage_directory_row" ||
    DIRECTORY_QUERY_HINT_PATTERN.test(query) ||
    NATURAL_BAGGAGE_QUERY_PATTERN.test(query)
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

function detectLinkedPolicyFacetRequests(query, facet = null) {
  const requests = DIRECTORY_LINKED_POLICY_FACETS.filter((entry) =>
    entry.pattern.test(query),
  );
  const requestFacets = new Set(requests.map((entry) => entry.facet));

  if (
    (facet === "first_checked_bag" || FULL_BAGGAGE_POLICY_PATTERN.test(query)) &&
    !requestFacets.has("first_checked_bag")
  ) {
    const firstBagRequest = DIRECTORY_LINKED_POLICY_FACETS.find(
      (entry) => entry.facet === "first_checked_bag",
    );
    if (firstBagRequest) {
      requests.unshift(firstBagRequest);
      requestFacets.add("first_checked_bag");
    }
  }

  if (
    FULL_BAGGAGE_POLICY_PATTERN.test(query) &&
    !requestFacets.has("additional_policy")
  ) {
    const additionalPolicyRequest = DIRECTORY_LINKED_POLICY_FACETS.find(
      (entry) => entry.facet === "additional_policy",
    );
    if (additionalPolicyRequest) {
      requests.push(additionalPolicyRequest);
    }
  }

  return uniqueBy(requests, (entry) => entry.facet);
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

function linkedPolicyFacetScore(hit, request) {
  const searchable = normalizeForSearch(
    [hit.title, hit.sectionTitle, hit.sectionPath?.join(" "), hit.text]
      .filter(Boolean)
      .join("\n"),
  );
  let score = hit.score || 0;

  if (request.facet === "first_checked_bag" || request.facet === "second_checked_bag") {
    if (/\b(checked|checked in|checked baggage|hold baggage|check in baggage)\b/u.test(searchable)) {
      score += 5;
    }
    if (/\b(allowance|fee|fees|price|prices|weight|dimension|size)\b/u.test(searchable)) {
      score += 2;
    }
    if (/\b(carry on|carryon|cabin baggage|personal item)\b/u.test(searchable)) {
      score -= 2;
    }
  }

  return score;
}

function pickBestLinkedPolicyHit(hits, request) {
  return [...hits].sort(
    (left, right) =>
      linkedPolicyFacetScore(right, request) -
        linkedPolicyFacetScore(left, request) ||
      (right.score || 0) - (left.score || 0),
  )[0];
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

function buildRouteProfile(text) {
  const normalized = normalizeForSearch(text || "");
  const matchedCountries = new Set();

  if (USA_LOCATION_PATTERN.test(text || "") || USA_LOCATION_PATTERN.test(normalized)) {
    matchedCountries.add("usa");
  }
  if (
    CANADA_LOCATION_PATTERN.test(text || "") ||
    CANADA_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("canada");
  }
  if (
    MEXICO_LOCATION_PATTERN.test(text || "") ||
    MEXICO_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("mexico");
  }
  if (
    BRAZIL_LOCATION_PATTERN.test(text || "") ||
    BRAZIL_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("brazil");
  }
  if (
    FRANCE_LOCATION_PATTERN.test(text || "") ||
    FRANCE_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("france");
  }
  if (
    UNITED_ARAB_EMIRATES_LOCATION_PATTERN.test(text || "") ||
    UNITED_ARAB_EMIRATES_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("united-arab-emirates");
  }
  if (
    GERMANY_LOCATION_PATTERN.test(text || "") ||
    GERMANY_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("germany");
  }
  if (
    NETHERLANDS_LOCATION_PATTERN.test(text || "") ||
    NETHERLANDS_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("netherlands");
  }
  if (
    TURKEY_LOCATION_PATTERN.test(text || "") ||
    TURKEY_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("turkey");
  }
  if (
    QATAR_LOCATION_PATTERN.test(text || "") ||
    QATAR_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("qatar");
  }
  if (
    UNITED_KINGDOM_LOCATION_PATTERN.test(text || "") ||
    UNITED_KINGDOM_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("united-kingdom");
  }
  if (
    INDIA_LOCATION_PATTERN.test(text || "") ||
    INDIA_LOCATION_PATTERN.test(normalized)
  ) {
    matchedCountries.add("india");
  }

  const explicitDomestic =
    /\bdomestic\b/u.test(normalized) || /\bwithin\b/u.test(normalized);
  const inferredDomestic =
    matchedCountries.size === 1 && /\b(to|from)\b/u.test(normalized);
  const inferredInternational = matchedCountries.size > 1;
  const hasDirectionalRoute =
    /\bto from\b/u.test(normalized) ||
    (/\bto\b/u.test(normalized) && /\bfrom\b/u.test(normalized)) ||
    (/\b(to|from)\b/u.test(normalized) && matchedCountries.size > 0);

  return {
    normalized,
    matchedCountries: [...matchedCountries],
    hasUsa: /\busa\b/u.test(normalized) || matchedCountries.has("usa"),
    hasCanada: /\bcanada\b/u.test(normalized) || matchedCountries.has("canada"),
    hasDomestic: explicitDomestic || inferredDomestic,
    hasInternational: /\binternational\b/u.test(normalized) || inferredInternational,
    hasBetween: /\bbetween\b/u.test(normalized),
    hasExcept: /\bexcept\b/u.test(normalized),
    hasToFrom: hasDirectionalRoute,
  };
}

function hasRouteSignals(routeIntent) {
  return Boolean(
    routeIntent.hasUsa ||
      routeIntent.hasCanada ||
      routeIntent.hasDomestic ||
      routeIntent.hasInternational ||
      routeIntent.hasBetween ||
      routeIntent.hasExcept ||
      routeIntent.hasToFrom,
  );
}

function routeScopeScore(routeIntent, row) {
  if (!hasRouteSignals(routeIntent)) {
    return 0;
  }

  const routeProfile = buildRouteProfile(row.routeScope || "");
  if (!routeProfile.normalized) {
    return -0.75;
  }

  let score = 0;

  if (routeIntent.hasUsa) {
    score += routeProfile.hasUsa ? 0.8 : -0.4;
  }
  if (routeIntent.hasCanada) {
    score += routeProfile.hasCanada ? 0.8 : -0.4;
  }
  if (routeIntent.hasDomestic) {
    score += routeProfile.hasDomestic ? 1.5 : -0.5;
  }
  if (routeIntent.hasInternational) {
    score += routeProfile.hasInternational ? 1.5 : -0.5;
  }
  if (routeIntent.hasBetween) {
    if (routeProfile.hasBetween && !routeProfile.hasExcept) {
      score += 2.5;
    } else if (routeProfile.hasExcept) {
      score -= 2.5;
    } else {
      score -= 0.5;
    }
  }
  if (routeIntent.hasToFrom) {
    if (routeProfile.hasToFrom && !routeProfile.hasExcept) {
      score += 2.5;
    } else if (routeProfile.hasExcept) {
      score -= 2.5;
    } else {
      score -= 0.5;
    }
  }
  if (routeIntent.hasExcept) {
    score += routeProfile.hasExcept ? 2 : -0.75;
  } else if (
    routeProfile.hasExcept &&
    (routeIntent.hasUsa ||
      routeIntent.hasCanada ||
      routeIntent.hasDomestic ||
      routeIntent.hasInternational ||
      routeIntent.hasBetween ||
      routeIntent.hasToFrom)
  ) {
    score -= 1.5;
  }

  return score || -0.75;
}

function structuredRowDetailRichness(row) {
  let score = 0;

  if (row.carryOnCost) {
    score += 1;
  }
  if (row.carryOnWeight) {
    score += 1;
  }
  if (row.carryOnSize) {
    score += 1;
  }
  if (row.carryOnNotes) {
    score += 0.5;
  }
  if (row.firstBagUrl) {
    score += 0.25;
  }
  if (row.secondBagUrl) {
    score += 0.25;
  }
  if (row.additionalPolicyUrl) {
    score += 0.25;
  }
  if (row.carryOnText && !/^view policy$/iu.test(String(row.carryOnText).trim())) {
    score += 0.5;
  }

  return Number(score.toFixed(6));
}

function carryOnFacetScore(row) {
  const detailRichness =
    Number(Boolean(row.carryOnCost)) +
    Number(Boolean(row.carryOnWeight)) +
    Number(Boolean(row.carryOnSize)) +
    Number(Boolean(row.carryOnNotes));

  if (detailRichness > 0) {
    return 1.5 + detailRichness * 0.5;
  }

  if (row.carryOnText) {
    return 0.35;
  }

  return 0;
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
      return carryOnFacetScore(row);
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
  routeIntent,
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

  score += routeScopeScore(routeIntent, row);
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

function compareDirectoryRowCandidates(left, right) {
  return (
    right.score - left.score ||
    right.detailRichness - left.detailRichness ||
    normalizeForSearch(right.row.routeScope || "").length -
      normalizeForSearch(left.row.routeScope || "").length
  );
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
    FULL_BAGGAGE_POLICY_PATTERN.test(query) ||
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

export {
  PRIVACY_ASPECT_LABELS,
  PRIVACY_TOPIC_BY_ID,
  uniqueBy,
  withCitations,
  hitKey,
  traceStep,
  summarizeTraceHit,
  summarizeTraceHits,
  normalizeHit,
  routeAirlines,
  buildVectorFilter,
  buildAirlineTargets,
  mergeSearchVariants,
  fuseRankedLists,
  shouldUseDirectoryRowMode,
  detectDirectoryFieldIntent,
  detectLinkedPolicyFacetRequests,
  buildLinkedPolicyQueries,
  pickBestLinkedPolicyHit,
  buildUrlVariants,
  buildRouteProfile,
  structuredRowDetailRichness,
  scoreDirectoryRow,
  compareDirectoryRowCandidates,
  formatStructuredRowHit,
  selectRowHitsForAirline,
  shouldKeepDirectoryRowFirst,
  detectPrivacyTopics,
  matchesPrivacyTopic,
  scorePrivacyTopicCandidate,
};
