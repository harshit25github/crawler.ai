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
const AMBIGUOUS_SINGLE_TOKEN_ALIASES = new Set([
  "blue",
  "canada",
  "denver",
  "dutch",
  "france",
  "india",
  "italia",
  "new",
  "royal",
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
  const suppressSingleCondensedAlias =
    condensed.length === 1 &&
    tokens.length > condensed.length &&
    (GENERIC_AIRLINE_WORDS.has(tokens[0]) ||
      AMBIGUOUS_SINGLE_TOKEN_ALIASES.has(condensed[0]));

  if (condensed.length) {
    if (!suppressSingleCondensedAlias) {
      aliases.add(condensed.join(" "));
      if (!AMBIGUOUS_SINGLE_TOKEN_ALIASES.has(condensed[0])) {
        aliases.add(condensed[0]);
      }
    }
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

export {
  BAGGAGE_FACETS,
  normalizeForSearch,
  detectFacet,
  detectPrivacyAspects,
  isComparisonQuery,
  detectRouteScopeHints,
  makeAirlineAliases,
  isLikelyAirlineName,
  matchAirlines,
  buildFtsQuery,
};
