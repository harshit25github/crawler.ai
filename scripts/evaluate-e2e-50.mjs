import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config as baseConfig } from "../src/indexing/index.js";
import { createKbSystem } from "../src/agents/index.js";

const ROOT_URLS = [
  "https://www.cheapoair.com/info/privacy#personal-information",
  "https://www.cheapoair.com/info/cookie-policy/",
  "https://www.cheapoair.com/info/generaltermsandconditions/",
  "https://www.cheapoair.com/travel/baggage-fees/",
];

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

function buildEvalConfig(outDir) {
  return {
    qdrantCollection: `url_kb_e2e50_${Date.now()}`,
    paths: {
      dataDir: outDir,
      crawl4aiDir: join(outDir, "crawl4ai"),
      rawDir: join(outDir, "raw"),
      chunksDir: join(outDir, "chunks"),
      tracesDir: join(outDir, "traces"),
    },
  };
}

function summarizeHit(hit) {
  return {
    citationIndex: hit.citationIndex,
    airlineName: hit.airlineName || null,
    sourceType: hit.sourceType || null,
    sectionTitle: hit.sectionTitle || null,
    sectionPath: hit.sectionPath || [],
    retrievalStrategy: hit.retrievalStrategy || null,
    searchVariants: hit.searchVariants || [],
    title: hit.title || null,
    url: hit.url,
    score: hit.score,
    preview: String(hit.text || "").replace(/\s+/gu, " ").slice(0, 220),
  };
}

function includesPattern(results, pattern, fieldGetter) {
  return results.some((result) => pattern.test(fieldGetter(result)));
}

function evaluateCase(testCase, results) {
  const failures = [];

  if (typeof testCase.expect.minResults === "number" && results.length < testCase.expect.minResults) {
    failures.push(
      `Expected at least ${testCase.expect.minResults} results, got ${results.length}.`,
    );
  }

  if (typeof testCase.expect.maxResults === "number" && results.length > testCase.expect.maxResults) {
    failures.push(
      `Expected at most ${testCase.expect.maxResults} results, got ${results.length}.`,
    );
  }

  for (const pattern of testCase.expect.requiredSectionPatterns || []) {
    if (!includesPattern(results, pattern, (result) => result.sectionTitle || "")) {
      failures.push(`Missing section pattern ${pattern}.`);
    }
  }

  for (const pattern of testCase.expect.requiredTextPatterns || []) {
    if (!includesPattern(results, pattern, (result) => result.text || "")) {
      failures.push(`Missing text pattern ${pattern}.`);
    }
  }

  for (const pattern of testCase.expect.requiredAirlinePatterns || []) {
    if (!includesPattern(results, pattern, (result) => result.airlineName || "")) {
      failures.push(`Missing airline pattern ${pattern}.`);
    }
  }

  for (const pattern of testCase.expect.requiredSourceTypePatterns || []) {
    if (!includesPattern(results, pattern, (result) => result.sourceType || "")) {
      failures.push(`Missing source type pattern ${pattern}.`);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
  };
}

function buildPrivacyCases() {
  const filter = {
    sourceType: "privacy_policy",
    domain: "www.cheapoair.com",
  };

  return [
    {
      id: "privacy_collect",
      category: "privacy",
      query: "What personal information does CheapOair collect, including contact and payment details?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/PERSONAL INFORMATION/iu],
        requiredTextPatterns: [/\bname\b|\bemail\b|\bpayment\b/iu],
      },
    },
    {
      id: "privacy_opt_out",
      category: "privacy",
      query: "How can I opt out of CheapOair marketing emails?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/Opt-Out of Marketing Emails/iu],
        requiredTextPatterns: [/\bopt-out\b|\bmarketing-related emails\b/iu],
      },
    },
    {
      id: "privacy_security_retention",
      category: "privacy",
      query: "What does the privacy policy say about security limitations and retention period?",
      topK: 8,
      filter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Security/iu, /Retention Period/iu],
      },
    },
    {
      id: "privacy_canada_state",
      category: "privacy",
      query: "Compare the Canadian privacy rights section with the U.S. state privacy law rights section.",
      topK: 8,
      filter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Canadian Privacy Rights/iu, /U\.S\. State Privacy Law Rights/iu],
      },
    },
    {
      id: "privacy_non_us_gdpr",
      category: "privacy",
      query: "Summarize what CheapOair says for non-US residents together with the GDPR notice.",
      topK: 8,
      filter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Non-US Residents/iu, /GDPR Notice/iu],
      },
    },
    {
      id: "privacy_third_party_advertising",
      category: "privacy",
      query: "What does the privacy policy say about third-party services and interest-based advertising?",
      topK: 8,
      filter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Third-Party Services/iu, /More On Advertising/iu],
      },
    },
    {
      id: "privacy_sensitive_security",
      category: "privacy",
      query: "What does CheapOair say about sensitive information and whether personal data can be guaranteed secure?",
      topK: 8,
      filter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Sensitive Information/iu, /Security/iu],
      },
    },
    {
      id: "privacy_collect_use_disclose",
      category: "privacy",
      query: "What information may CheapOair collect, how may it use it for bookings, and how may it disclose it?",
      topK: 8,
      filter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/\bPersonal Information We May Collect\b|\bname\b|\bemail\b/iu, /\bHow We May Use Personal Information\b|\bprocess your payment\b/iu, /\bHow Personal Information May Be Disclosed\b|\bdisclosed or transferred\b/iu],
      },
    },
  ];
}

function buildCookieCases() {
  const filter = {
    sourceType: "cookie_policy",
    domain: "www.cheapoair.com",
  };

  return [
    {
      id: "cookie_define",
      category: "cookie",
      query: "What does CheapOair say a cookie is in its cookie policy?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/What are cookies\?/iu],
        requiredTextPatterns: [/\bsmall text file\b|\bremember your actions and preferences\b/iu],
      },
    },
    {
      id: "cookie_categories",
      category: "cookie",
      query: "What types of cookies does CheapOair say it uses and how are first-party and third-party cookies described?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/What types of cookies do we use and how do we use them\?/iu],
        requiredTextPatterns: [/\b1st and 3rd-party session and persistent cookies\b|\b1st party cookies\b|\b3rd party cookies\b/iu],
      },
    },
    {
      id: "cookie_strictly_necessary",
      category: "cookie",
      query: "What are strictly necessary cookies used for according to CheapOair?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredTextPatterns: [/\bStrictly Necessary Cookies\b|\blog-in functionality\b|\bload balancing\b/iu],
      },
    },
    {
      id: "cookie_performance_functional",
      category: "cookie",
      query: "How does CheapOair describe performance cookies and functional cookies?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredTextPatterns: [/\bPerformance cookies\b|\bFunctional cookies\b|\blanguage preferences\b/iu],
      },
    },
    {
      id: "cookie_advertising",
      category: "cookie",
      query: "What do advertising cookies do in the CheapOair cookie policy?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredTextPatterns: [/\bAdvertising Cookies\b|\brelevant advertisements\b|\bmarketing campaigns\b/iu],
      },
    },
    {
      id: "cookie_analytics_personalization",
      category: "cookie",
      query: "How do analytics and personalization cookies help CheapOair personalize travel options and deals?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredTextPatterns: [/\bAnalytics and Personalization Cookies\b|\bbooking or purchase history\b|\btravel options and deals\b/iu],
      },
    },
    {
      id: "cookie_social_media",
      category: "cookie",
      query: "What are social media cookies used for?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredTextPatterns: [/\bSocial Media Cookies\b|\bshare or like our pages\b/iu],
      },
    },
    {
      id: "cookie_control",
      category: "cookie",
      query: "How can a user control cookies and opt out of online behavioural advertising according to CheapOair?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/How to control cookies\?/iu],
        requiredTextPatterns: [/\byouronlinechoices\.com\b|\bdelete all cookies\b|\bset most browsers to prevent them\b/iu],
      },
    },
  ];
}

function buildTermsCases() {
  const filter = {
    sourceType: "terms_conditions",
    domain: "www.cheapoair.com",
  };

  return [
    {
      id: "terms_intro_arbitration",
      category: "terms",
      query: "What do the terms say about mandatory arbitration and class action waiver?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/INTRODUCTION/iu],
        requiredTextPatterns: [/\bMANDATORY ARBITRATION\b|\bCLASS ACTION WAIVER\b/iu],
      },
    },
    {
      id: "terms_safe_shopping",
      category: "terms",
      query: "What does CheapOair say in the safe shopping guarantee about protecting personal information?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/INTRODUCTION/iu],
        requiredTextPatterns: [/\bSAFE SHOPPING GUARANTEE\b|\breasonable organizational, technical, and administrative measures\b/iu],
      },
    },
    {
      id: "terms_intermediary_role",
      category: "terms",
      query: "According to the terms, does CheapOair act as principal or as an intermediary arranging services with travel suppliers?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/IMPORTANT NOTICE/iu],
        requiredTextPatterns: [/\bdoes not act as principal\b|\bsimply makes arrangements with third-party vendors\b/iu],
      },
    },
    {
      id: "terms_supplier_default",
      category: "terms",
      query: "What do the terms say about supplier defaults and who the customer’s sole recourse is for a refund?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/IMPORTANT NOTICE/iu],
        requiredTextPatterns: [/\bsole recourse for a refund shall be the defaulting Travel Supplier\b|\bsupplier defaults\b/iu],
      },
    },
    {
      id: "terms_price_match",
      category: "terms",
      query: "What does CheapOair say in the price match promise?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/PRICE MATCH PROMISE/iu],
        requiredTextPatterns: [/\blower price\b|\bMajor OTA Competitor\b/iu],
      },
    },
    {
      id: "terms_resolution",
      category: "terms",
      query: "What does the resolution of disputes section say about arbitration, jury trial waiver, and class proceedings?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/RESOLUTION OF DISPUTES/iu],
        requiredTextPatterns: [/\bagreement to arbitrate disputes\b|\bwaive trial by jury\b|\bclass\b/iu],
      },
    },
    {
      id: "terms_fees",
      category: "terms",
      query: "What do the terms say about CheapOair service fees and whether they are refundable?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/OUR FEES AND EXCEPTIONS/iu],
        requiredTextPatterns: [/\bservice fee\b|\bnon-refundable\b/iu],
      },
    },
    {
      id: "terms_cancel_refund",
      category: "terms",
      query: "What do the terms say about cancellations, refunds after 24 hours, and trip protection refunds?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/CANCEL AND REFUND/iu],
        requiredTextPatterns: [/\bnon-refundable after 24 hours of booking\b|\brefundable within 10 days of purchase\b/iu],
      },
    },
    {
      id: "terms_payment_acceptance",
      category: "terms",
      query: "What cards and billing behavior does the payment acceptance policy mention?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/PAYMENT ACCEPTANCE POLICY/iu],
        requiredTextPatterns: [/\bcredit cards and debit cards\b|\bbilled in multiple charges\b/iu],
      },
    },
    {
      id: "terms_baggage_fees",
      category: "terms",
      query: "What do the terms say about baggage policy and fees, especially charges for checked bags?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/BAGGAGE POLICY AND FEES/iu],
        requiredTextPatterns: [/\bMost airlines now charge baggage fees even for the first bag checked-in\b|\bexcess baggage fee\b/iu],
      },
    },
    {
      id: "terms_connecting_flights_bags",
      category: "terms",
      query: "What does CheapOair say about baggage policy on connecting flights and rechecking bags?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/BAGGAGE POLICY ON CONNECTING FLIGHTS/iu],
        requiredTextPatterns: [/\breclaim your bags\b|\bcheck-in again to continue your journey\b/iu],
      },
    },
    {
      id: "terms_unaccompanied_minor",
      category: "terms",
      query: "What do the terms say about unaccompanied minors and airline-specific rules?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/UNACCOMPANIED MINOR/iu],
        requiredTextPatterns: [/\bEach airline sets its own policies and regulations\b|\bunaccompanied minors\b/iu],
      },
    },
    {
      id: "terms_visa",
      category: "terms",
      query: "What do the terms say about visa and entry requirements and where travelers should verify documents?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/VISA AND ENTRY REQUIREMENTS/iu],
        requiredTextPatterns: [/\bverify travel documents\b|\btravel\.state\.gov\b/iu],
      },
    },
    {
      id: "terms_hazardous",
      category: "terms",
      query: "What does CheapOair say about hazardous materials and possible penalties?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/HAZARDOUS MATERIALS/iu],
        requiredTextPatterns: [/\bfive years of imprisonment\b|\$250,000\b|\bhazardous materials\b/iu],
      },
    },
  ];
}

function buildOfficialCases() {
  const filter = { sourceType: "airline_policy" };

  return [
    {
      id: "official_delta_carry_on",
      category: "official_policy",
      query: "What is Delta carry-on baggage policy including the personal item?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Delta/iu],
        requiredTextPatterns: [/\bcarry-on\b|\bpersonal item\b/iu],
      },
    },
    {
      id: "official_delta_free_items",
      category: "official_policy",
      query: "What free items does Delta allow in addition to usual carry-on items?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Delta/iu],
        requiredTextPatterns: [/\bFree Items to Carry On\b|\bjacket\b|\bumbrella\b/iu],
      },
    },
    {
      id: "official_united_size",
      category: "official_policy",
      query: "What are United carry-on size limits and personal item size limits?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/United/iu],
        requiredTextPatterns: [/9 in x 14 in x 22 in|9 in x 10 in x 17 in|size limits/iu],
      },
    },
    {
      id: "official_united_checked",
      category: "official_policy",
      query: "What does United say about checked bag charges and fee calculation?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/United/iu],
        requiredTextPatterns: [/\bchecked bag charges depend\b|\bchecked bag fee calculator\b/iu],
      },
    },
    {
      id: "official_ba_hand_baggage",
      category: "official_policy",
      query: "What does British Airways say about hand baggage allowances?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/British Airways/iu],
        requiredTextPatterns: [/\bhand baggage\b|\bbaggage essentials\b/iu],
      },
    },
    {
      id: "official_compare_delta_united",
      category: "official_policy",
      query: "Compare Delta and United carry-on baggage rules.",
      topK: 8,
      filter,
      expect: {
        minResults: 2,
        requiredAirlinePatterns: [/Delta/iu, /United/iu],
      },
    },
  ];
}

function buildDirectoryCases() {
  const filter = {
    sourceType: "baggage_directory",
    domain: "www.cheapoair.com",
  };

  return [
    {
      id: "directory_aegean_weight",
      category: "directory",
      query: "According to the CheapOair baggage fees page, what is Aegean Airlines carry-on weight allowance?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Aegean Airlines/iu],
        requiredSourceTypePatterns: [/baggage_directory_row/iu],
        requiredTextPatterns: [/8 kg \/ 17 lb/iu],
      },
    },
    {
      id: "directory_aegean_linked_first_bag",
      category: "directory",
      query: "According to the CheapOair baggage fees page, what are Aegean Airlines carry-on and 1st bag details?",
      topK: 4,
      filter,
      expect: {
        minResults: 2,
        requiredAirlinePatterns: [/Aegean Airlines/iu],
        requiredSourceTypePatterns: [/baggage_directory_row/iu, /airline_policy/iu],
        requiredTextPatterns: [/8 kg \/ 17 lb/iu, /\bchecked baggage\b|\bchecked bag\b/iu],
      },
    },
    {
      id: "directory_air_canada_size",
      category: "directory",
      query: "According to the CheapOair baggage fees page, what carry-on size does Air Canada list?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Air Canada/iu],
        requiredTextPatterns: [/55 x 40 x 23|118 cm/iu],
      },
    },
    {
      id: "directory_aeromexico_notes",
      category: "directory",
      query: "According to the CheapOair baggage fees page, what carry-on notes does Aeromexico list?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Aeromexico/iu],
        requiredTextPatterns: [/Briefcases, purses, computers|fit under the cabin seats/iu],
      },
    },
    {
      id: "directory_air_baltic_notes",
      category: "directory",
      query: "According to the CheapOair baggage fees page, what note does Air Baltic list for carry-on baggage?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Air Baltic/iu],
        requiredTextPatterns: [/total combined weight of the cabin bag and the personal item cannot exceed 8 kg/iu],
      },
    },
    {
      id: "directory_compare_aegean_air_india",
      category: "directory",
      query: "Compare Aegean Airlines and Air India carry-on weight according to the CheapOair baggage fees page.",
      topK: 8,
      filter,
      expect: {
        minResults: 2,
        requiredAirlinePatterns: [/Aegean Airlines/iu, /Air India/iu],
        requiredTextPatterns: [/8 kg|17 lb/iu, /7kg|17lb/iu],
      },
    },
    {
      id: "directory_compare_air_canada_air_france",
      category: "directory",
      query: "Compare Air Canada and Air France carry-on size entries on the CheapOair baggage fees page.",
      topK: 8,
      filter,
      expect: {
        minResults: 2,
        requiredAirlinePatterns: [/Air Canada/iu, /Air France/iu],
        requiredTextPatterns: [/55 x 40 x 23/iu, /55 x 35 x 25/iu],
      },
    },
    {
      id: "directory_volaris_international",
      category: "directory",
      query: "According to the CheapOair baggage fees page, what does Volaris list for international flights carry-on cost?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Volaris/iu],
        requiredTextPatterns: [/Only Personal Item - Free/iu],
      },
    },
    {
      id: "directory_air_baltic_us_canada_size",
      category: "directory",
      query: "According to the CheapOair baggage fees page, what carry-on size does Air Baltic list for routes to or from USA and Canada?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Air Baltic/iu],
        requiredTextPatterns: [/55 x 40 x 23|43" \(19 x 15 x 9\)/iu],
      },
    },
    {
      id: "directory_aegean_personal_item_note",
      category: "directory",
      query: "According to the CheapOair baggage fees page, what personal item note does Aegean Airlines list for carry-on baggage?",
      topK: 6,
      filter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Aegean Airlines/iu],
        requiredTextPatterns: [/thin laptop case|fit under the seat in front of you/iu],
      },
    },
  ];
}

function buildNegativeCases() {
  return [
    {
      id: "negative_aer_lingus",
      category: "negative",
      query: "What is Aer Lingus carry-on baggage policy?",
      topK: 6,
      filter: {
        sourceType: "airline_policy",
        airline: "Aer Lingus",
      },
      expect: {
        maxResults: 0,
      },
    },
    {
      id: "negative_aerolineas",
      category: "negative",
      query: "What is Aerolineas Argentinas baggage policy?",
      topK: 6,
      filter: {
        sourceType: "airline_policy",
        airline: "Aerolineas Argentinas",
      },
      expect: {
        maxResults: 0,
      },
    },
    {
      id: "negative_mystery_air",
      category: "negative",
      query: "What is Mystery Air carry-on baggage policy?",
      topK: 6,
      filter: {
        sourceType: "airline_policy",
        airline: "Mystery Air",
      },
      expect: {
        maxResults: 0,
      },
    },
    {
      id: "negative_orbit_express",
      category: "negative",
      query: "What is Orbit Express baggage policy?",
      topK: 6,
      filter: {
        sourceType: "airline_policy",
        airline: "Orbit Express",
      },
      expect: {
        maxResults: 0,
      },
    },
  ];
}

function buildCases() {
  const cases = [
    ...buildPrivacyCases(),
    ...buildCookieCases(),
    ...buildTermsCases(),
    ...buildOfficialCases(),
    ...buildDirectoryCases(),
    ...buildNegativeCases(),
  ];

  if (cases.length !== 50) {
    throw new Error(`Expected 50 cases, built ${cases.length}.`);
  }

  return cases;
}

function summarizeByCategory(results) {
  const summary = {};

  for (const result of results) {
    const entry = summary[result.category] || {
      total: 0,
      passed: 0,
      failed: 0,
    };
    entry.total += 1;
    if (result.pass) {
      entry.passed += 1;
    } else {
      entry.failed += 1;
    }
    summary[result.category] = entry;
  }

  return Object.fromEntries(
    Object.entries(summary).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function renderMarkdown(report) {
  const lines = [
    "# E2E 50-Case Evaluation Report",
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Output dir: ${report.outputDir}`,
    `- Qdrant collection: ${report.qdrantCollection}`,
    `- Root URLs crawled: ${report.ingestion.root.total}`,
    `- Deep-run docs indexed: ${report.ingestion.run.indexed}`,
    "",
    "## Summary",
    "",
    `- Total cases: ${report.summary.total}`,
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    "",
    "## Category Summary",
    "",
  ];

  for (const [category, stats] of Object.entries(report.byCategory)) {
    lines.push(`- ${category}: ${stats.passed}/${stats.total} passed (${stats.failed} failed)`);
  }

  lines.push("");
  lines.push("## Failed Cases");
  lines.push("");

  const failed = report.results.filter((item) => !item.pass);
  if (!failed.length) {
    lines.push("- none");
  } else {
    for (const item of failed) {
      lines.push(`### ${item.id} (${item.category})`);
      lines.push("");
      lines.push(`- Query: ${item.query}`);
      lines.push(`- Failures: ${item.failures.join(" | ")}`);
      lines.push("- Top hits:");
      if (!item.topHits.length) {
        lines.push("  - none");
      } else {
        for (const hit of item.topHits) {
          lines.push(
            `  - [${hit.citationIndex}] ${hit.airlineName || hit.sourceType || "n/a"} | ${hit.sectionTitle || hit.title || "n/a"} | ${hit.retrievalStrategy || "n/a"} | ${hit.preview}`,
          );
        }
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(
    process.cwd(),
    args.outDir || "data/evals/e2e-50-latest",
  );
  const runDir = resolve(
    process.cwd(),
    args.runDir ||
      "data/crawl4ai/runs/2026-03-05T10-08-19-582Z-baggage-fees-all-links",
  );

  if (!baseConfig.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required for the E2E 50-case evaluation.");
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const kb = createKbSystem(buildEvalConfig(outDir));
  await kb.qdrantService.deleteCollection();

  console.log(`Crawling and indexing ${ROOT_URLS.length} root URLs`);
  const rootIngestion = await kb.ingestUrls(ROOT_URLS, { force: true });

  console.log(`Importing deep crawl run from ${runDir}`);
  const runIngestion = await kb.ingestRunDirectory(runDir);

  const cases = buildCases();
  const results = [];

  for (const testCase of cases) {
    console.log(`Running case ${testCase.id}`);
    const hits = await kb.retrieve(testCase.query, {
      topK: testCase.topK,
      filter: testCase.filter,
    });
    const evaluation = evaluateCase(testCase, hits);

    results.push({
      id: testCase.id,
      category: testCase.category,
      query: testCase.query,
      filter: testCase.filter,
      pass: evaluation.pass,
      failures: evaluation.failures,
      resultCount: hits.length,
      topHits: hits.slice(0, 4).map(summarizeHit),
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    outputDir: outDir,
    qdrantCollection: kb.config.qdrantCollection,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.pass).length,
      failed: results.filter((item) => !item.pass).length,
    },
    byCategory: summarizeByCategory(results),
    ingestion: {
      root: rootIngestion,
      run: runIngestion,
    },
    results,
  };

  const jsonPath = join(outDir, "report.json");
  const mdPath = join(outDir, "report.md");

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, renderMarkdown(report), "utf8");

  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report written to ${jsonPath}`);
  console.log(`Markdown written to ${mdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
