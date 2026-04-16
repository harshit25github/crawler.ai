import { mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  buildVectorArtifacts,
  config as baseConfig,
  OpenAIService,
  QdrantService,
  readJson,
  RunImportService,
} from "../src/indexing/index.js";
import { RetrievalService } from "../src/retrieval/index.js";

const ROOT_URL_PATTERNS = [
  /https:\/\/www\.cheapoair\.com\/info\/privacy/iu,
  /https:\/\/www\.cheapoair\.com\/travel\/baggage-fees\/?$/iu,
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
    ...baseConfig,
    qdrantCollection: `url_kb_complex_${Date.now()}`,
    paths: {
      ...baseConfig.paths,
      evalDir: outDir,
      chunksDir: join(outDir, "chunks"),
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

  for (const pattern of testCase.expect.requiredAirlinePatterns || []) {
    if (!includesPattern(results, pattern, (result) => result.airlineName || "")) {
      failures.push(`Missing airline pattern ${pattern}.`);
    }
  }

  for (const pattern of testCase.expect.requiredTextPatterns || []) {
    if (!includesPattern(results, pattern, (result) => result.text || "")) {
      failures.push(`Missing text pattern ${pattern}.`);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
  };
}

function makeDirectoryCase({ id, category, query, airline, pattern, topK = 6 }) {
  return {
    id,
    category,
    query,
    topK,
    filter: {
      sourceType: "baggage_directory",
      domain: "www.cheapoair.com",
    },
    expect: {
      minResults: 1,
      requiredTextPatterns: [new RegExp(airline, "iu"), pattern],
    },
  };
}

function makeDirectoryLinkedPolicyCase({
  id,
  query,
  airlinePattern,
  pattern,
  topK = 6,
}) {
  return {
    id,
    category: "directory_linked_policy",
    query,
    topK,
    filter: {
      sourceType: "baggage_directory",
      domain: "www.cheapoair.com",
    },
    expect: {
      minResults: 2,
      requiredAirlinePatterns: [airlinePattern],
      requiredTextPatterns: [pattern],
    },
  };
}

function buildPrivacySingleCases() {
  return [
    {
      id: "privacy_owner_operator",
      category: "privacy_single",
      query: "Who owns and operates CheapOair according to the privacy policy?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/INTRODUCTION/iu],
        requiredTextPatterns: [/Fareportal/iu],
      },
    },
    {
      id: "privacy_personal_information_collect",
      category: "privacy_single",
      query: "What personal information does CheapOair collect?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/PERSONAL INFORMATION/iu],
        requiredTextPatterns: [/\bname\b|\bemail\b|\bphone\b|\bpayment\b/iu],
      },
    },
    {
      id: "privacy_analytics_advertising_data",
      category: "privacy_single",
      query: "What analytics or advertising data does CheapOair say it may automatically collect?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/PERSONAL INFORMATION/iu],
        requiredTextPatterns: [/\bAnalytics\/Advertising Data\b|\bautomatically collect\b/iu],
      },
    },
    {
      id: "privacy_use_of_information",
      category: "privacy_single",
      query: "How does CheapOair say it may use personal information?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/PERSONAL INFORMATION/iu],
        requiredTextPatterns: [/\bHow We May Use Personal Information\b|\bcomplete and fulfill your booking\b/iu],
      },
    },
    {
      id: "privacy_disclosure_of_information",
      category: "privacy_single",
      query: "How may CheapOair disclose personal information?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/PERSONAL INFORMATION/iu],
        requiredTextPatterns: [/\bHow Personal Information May Be Disclosed\b|\bdisclosed or transferred\b/iu],
      },
    },
    {
      id: "privacy_sensitive_information",
      category: "privacy_single",
      query: "What does CheapOair say about sensitive personal information?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/Sensitive Information/iu],
        requiredTextPatterns: [/\bnot send us\b|\bSensitive Information\b/iu],
      },
    },
    {
      id: "privacy_third_party_services",
      category: "privacy_single",
      query: "What does the privacy policy say about third-party services?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/Third-Party Services/iu],
        requiredTextPatterns: [/\bnot responsible\b|\bthird parties\b/iu],
      },
    },
    {
      id: "privacy_more_on_advertising",
      category: "privacy_single",
      query: "What advertising choices does CheapOair mention in the privacy policy?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/More On Advertising/iu],
        requiredTextPatterns: [/\binterest-based advertising\b|\bNetwork Advertising Initiative\b/iu],
      },
    },
    {
      id: "privacy_security",
      category: "privacy_single",
      query: "Does CheapOair guarantee complete security of personal information?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/Security/iu],
        requiredTextPatterns: [/\bUnfortunately\b|\bcannot be guaranteed to be secure\b|\bguaranteed to be secure\b/iu],
      },
    },
    {
      id: "privacy_retention_period",
      category: "privacy_single",
      query: "What does CheapOair say about retention period for personal information?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/Retention Period/iu],
        requiredTextPatterns: [/\bretain your Personal Information\b|\blonger retention period\b/iu],
      },
    },
    {
      id: "privacy_opt_out_marketing",
      category: "privacy_single",
      query: "How can I opt out of marketing emails from CheapOair?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/Opt-Out of Marketing Emails/iu],
        requiredTextPatterns: [/\bopt-out\b|\bmarketing-related emails\b/iu],
      },
    },
    {
      id: "privacy_non_us_residents",
      category: "privacy_single",
      query: "What notice applies to non-US residents in the privacy policy?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/Non-US Residents/iu],
      },
    },
    {
      id: "privacy_canadian_rights",
      category: "privacy_single",
      query: "What does CheapOair say about Canadian privacy rights?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/Canadian Privacy Rights/iu],
      },
    },
    {
      id: "privacy_gdpr_notice",
      category: "privacy_single",
      query: "What GDPR notice does CheapOair provide?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/GDPR Notice/iu],
        requiredTextPatterns: [/\bEuropean Economic Area\b|\bGDPR\b/iu],
      },
    },
    {
      id: "privacy_us_state_rights",
      category: "privacy_single",
      query: "What U.S. state privacy law rights does CheapOair mention?",
      topK: 6,
      filter: { sourceType: "privacy_policy", domain: "www.cheapoair.com" },
      expect: {
        minResults: 1,
        requiredSectionPatterns: [/U\.S\. State Privacy Law Rights/iu],
        requiredTextPatterns: [/\bCalifornia\b|\bColorado\b|\bresident\b/iu],
      },
    },
  ];
}

function buildPrivacyMultiCases() {
  const baseFilter = {
    sourceType: "privacy_policy",
    domain: "www.cheapoair.com",
  };

  return [
    {
      id: "privacy_multi_canada_opt_out",
      category: "privacy_multi",
      query: "Tell me both the Canadian privacy rights section and how to opt out of marketing emails.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Canadian Privacy Rights/iu, /Opt-Out of Marketing Emails/iu],
      },
    },
    {
      id: "privacy_multi_non_us_gdpr",
      category: "privacy_multi",
      query: "Summarize what the policy says for non-US residents and the GDPR notice.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Non-US Residents/iu, /GDPR Notice/iu],
      },
    },
    {
      id: "privacy_multi_security_retention",
      category: "privacy_multi",
      query: "What does CheapOair say about security and retention period?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Security/iu, /Retention Period/iu],
      },
    },
    {
      id: "privacy_multi_third_party_advertising",
      category: "privacy_multi",
      query: "What does the policy say about third-party services and more on advertising?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Third-Party Services/iu, /More On Advertising/iu],
      },
    },
    {
      id: "privacy_multi_collection_disclosure",
      category: "privacy_multi",
      query: "What personal information does CheapOair collect and how may it disclose it?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/\bPersonal Information We May Collect\b|\bname\b|\bemail\b/iu, /\bHow Personal Information May Be Disclosed\b|\bdisclosed or transferred\b/iu],
      },
    },
    {
      id: "privacy_multi_sensitive_security",
      category: "privacy_multi",
      query: "What does CheapOair say about sensitive information and security limitations?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Sensitive Information/iu, /Security/iu],
      },
    },
    {
      id: "privacy_multi_state_canada",
      category: "privacy_multi",
      query: "Compare the U.S. state privacy rights section with the Canadian privacy rights section.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/U\.S\. State Privacy Law Rights/iu, /Canadian Privacy Rights/iu],
      },
    },
    {
      id: "privacy_multi_intro_collection",
      category: "privacy_multi",
      query: "Who operates CheapOair and what kinds of personal information may it collect?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/INTRODUCTION/iu, /PERSONAL INFORMATION/iu],
        requiredTextPatterns: [/\bFareportal\b/iu],
      },
    },
    {
      id: "privacy_multi_analytics_ad_choices",
      category: "privacy_multi",
      query: "How does the policy describe analytics or advertising data and advertising choices?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/PERSONAL INFORMATION/iu, /More On Advertising/iu],
        requiredTextPatterns: [/\bAnalytics\/Advertising Data\b|\bautomatically collect\b/iu],
      },
    },
    {
      id: "privacy_multi_retention_opt_out",
      category: "privacy_multi",
      query: "Show me both the retention period details and the marketing email opt-out instructions.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Retention Period/iu, /Opt-Out of Marketing Emails/iu],
      },
    },
    {
      id: "privacy_multi_non_us_canada",
      category: "privacy_multi",
      query: "What does CheapOair say for non-US residents and for Canadian residents?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Non-US Residents/iu, /Canadian Privacy Rights/iu],
      },
    },
    {
      id: "privacy_multi_third_party_sensitive",
      category: "privacy_multi",
      query: "What does the privacy policy say about third parties and sensitive information?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Third-Party Services/iu, /Sensitive Information/iu],
      },
    },
    {
      id: "privacy_multi_gdpr_state",
      category: "privacy_multi",
      query: "Show the GDPR notice together with the U.S. state privacy rights section.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/GDPR Notice/iu, /U\.S\. State Privacy Law Rights/iu],
      },
    },
    {
      id: "privacy_multi_security_advertising",
      category: "privacy_multi",
      query: "What does CheapOair say about security and interest-based advertising?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredSectionPatterns: [/Security/iu, /More On Advertising/iu],
      },
    },
    {
      id: "privacy_multi_collection_use",
      category: "privacy_multi",
      query: "What information may CheapOair collect and how may it use it for bookings and payments?",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/\bPersonal Information We May Collect\b|\bpayment\b/iu, /\bHow We May Use Personal Information\b|\bprocess your payment\b/iu],
      },
    },
  ];
}

function buildOfficialPolicyCases() {
  const baseFilter = { sourceType: "airline_policy" };

  return [
    {
      id: "official_delta_carry_on",
      category: "official_policy",
      query: "What is Delta carry-on baggage policy?",
      topK: 6,
      filter: baseFilter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Delta/iu],
        requiredTextPatterns: [/\bcarry-on\b|\bpersonal item\b/iu],
      },
    },
    {
      id: "official_delta_personal_item",
      category: "official_policy",
      query: "What does Delta say about a personal item in carry-on baggage?",
      topK: 6,
      filter: baseFilter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Delta/iu],
        requiredTextPatterns: [/\bpersonal item\b/iu],
      },
    },
    {
      id: "official_delta_free_items",
      category: "official_policy",
      query: "What free items does Delta say you can carry on in addition to usual carry-on items?",
      topK: 6,
      filter: baseFilter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Delta/iu],
        requiredTextPatterns: [/\bFree Items to Carry On\b|\bjacket\b|\bumbrella\b/iu],
      },
    },
    {
      id: "official_delta_fee_exceptions",
      category: "official_policy",
      query: "What baggage rules and fee exceptions does Delta mention?",
      topK: 6,
      filter: baseFilter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/Delta/iu],
        requiredTextPatterns: [/\bBaggage Rules & Fee Exceptions\b|\bActive Military\b|\bMedallion Members\b/iu],
      },
    },
    {
      id: "official_united_size_limits",
      category: "official_policy",
      query: "What are United carry-on size limits?",
      topK: 6,
      filter: baseFilter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/United/iu],
        requiredTextPatterns: [/9 in x 14 in x 22 in|\bSize limits\b/iu],
      },
    },
    {
      id: "official_united_personal_items",
      category: "official_policy",
      query: "What does United say about personal item size?",
      topK: 6,
      filter: baseFilter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/United/iu],
        requiredTextPatterns: [/9 in x 10 in x 17 in|\bPersonal items\b/iu],
      },
    },
    {
      id: "official_united_gate_checked",
      category: "official_policy",
      query: "When does United say a carry-on bag might be gate-checked?",
      topK: 6,
      filter: baseFilter,
      expect: {
        minResults: 1,
        requiredAirlinePatterns: [/United/iu],
        requiredTextPatterns: [/\bgate-checked\b|\boverhead space\b/iu],
      },
    },
    {
      id: "official_united_checked_charges",
      category: "official_policy",
      query: "What does United say about checked bag charges?",
      topK: 6,
      filter: baseFilter,
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
      filter: baseFilter,
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
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredAirlinePatterns: [/Delta/iu, /United/iu],
        requiredTextPatterns: [/\bcarry-on\b|\bpersonal item\b/iu],
      },
    },
  ];
}

function buildDirectorySingleCases() {
  const airlines = [
    {
      id: "aegean",
      airline: "Aegean Airlines",
      short: "Aegean Airlines",
      cost: /Free:\s*Only Personal Item|\*\*Cost:\*\*\s*Free:\s*Only Personal Item/iu,
      weight: /8 kg\s*\/\s*17 lb/iu,
      size: /56 x 45 x 25|22" x 17" x 9"/iu,
      note: /thin laptop case|fit under the seat in front of you/iu,
    },
    {
      id: "aeromexico",
      airline: "Aeromexico",
      short: "Aeromexico",
      cost: /\*\*Cost:\*\*\s*Free/iu,
      weight: /22 lb\s*\/\s*10 kg/iu,
      size: /120 cm \(25 x 40 x 55\)|47\.2"/iu,
      note: /Briefcases, purses, computers, umbrellas, waist bags|fit under the cabin seats/iu,
    },
    {
      id: "air_astana",
      airline: "Air Astana",
      short: "Air Astana",
      cost: /\*\*Cost:\*\*\s*Free/iu,
      weight: /8kg\s*\/\s*17lb/iu,
      size: /126cm \(56 x 45 x 25\)/iu,
      note: /small handbag or laptop bag\/ briefcase/iu,
    },
    {
      id: "air_baltic",
      airline: "Air Baltic",
      short: "Air Baltic",
      cost: /\*\*Cost:\*\*\s*Free/iu,
      weight: /17lb\s*\/\s*8kg/iu,
      size: /118cm \(23 x 40 x 55\)|118cm \(55 x 40 x 23\)/iu,
      note: /total combined weight of the cabin bag and the personal item cannot exceed 8 kg|80cm \(30 x 40 x 10\)/iu,
    },
    {
      id: "air_canada",
      airline: "Air Canada",
      short: "Air Canada",
      cost: /\*\*Cost:\*\*\s*Free/iu,
      weight: /Weight:\s*Na/iu,
      size: /118 cm \(55 x 40 x 23\)|46"/iu,
      note: /Personal Article\s*:36" \(17 x 13 x 6\)|92 cm \(43 x 33 x 16\)/iu,
    },
    {
      id: "air_europa",
      airline: "Air Europa",
      short: "Air Europa",
      cost: /\*\*Cost:\*\*\s*Free/iu,
      weight: /20lb\s*\/\s*10kg/iu,
      size: /115cm \(25 x 35 x 55\)/iu,
      note: /Personal Item:\s*85cm \(40 x 30 x 15\)/iu,
    },
    {
      id: "air_france",
      airline: "Air France",
      short: "Air France",
      cost: /\*\*Cost:\*\*\s*Free/iu,
      weight: /12kg\s*\/\s*26lb/iu,
      size: /115cm \(55 x 35 x 25\)|45\.4"/iu,
      note: /personal accessory which should not exceed the following dimensions: 40 x 30 x 15 cm/iu,
    },
    {
      id: "air_india",
      airline: "Air India",
      short: "Air India",
      cost: /\*\*Cost:\*\*\s*Free/iu,
      weight: /17lb\s*\/\s*7kg/iu,
      size: /115cm \(55 x 40 x 20\)|45\.1"/iu,
      note: /handbag\/briefcase\/laptop|One additional personal item permitted/iu,
    },
    {
      id: "air_new_zealand",
      airline: "Air New Zealand",
      short: "Air New Zealand",
      cost: /\*\*Cost:\*\*\s*Free/iu,
      weight: /15lb\s*\/\s*7kg/iu,
      size: /46\.5"\s*\/\s*118 cm/iu,
      note: /one additional personal item permitted such as handbag, slim laptop bag/iu,
    },
    {
      id: "air_serbia",
      airline: "Air Serbia",
      short: "Air Serbia",
      cost: /\*\*Cost:\*\*\s*Free/iu,
      weight: /17lb\s*\/\s*8kg/iu,
      size: /115cm \(40 x 23 x 55\)/iu,
      note: /additional personal item max 4kg permitted|purse \/ laptop bag \/ briefcase \/ small backpack/iu,
    },
  ];

  const cases = [];

  for (const airline of airlines) {
    cases.push(
      makeDirectoryCase({
        id: `directory_${airline.id}_cost`,
        category: "directory_single",
        airline: airline.airline,
        query: `According to the CheapOair baggage fees page, what does ${airline.short} say about carry-on cost?`,
        pattern: airline.cost,
      }),
      makeDirectoryCase({
        id: `directory_${airline.id}_weight`,
        category: "directory_single",
        airline: airline.airline,
        query: `According to the CheapOair baggage fees page, what is ${airline.short} carry-on weight allowance?`,
        pattern: airline.weight,
      }),
      makeDirectoryCase({
        id: `directory_${airline.id}_size`,
        category: "directory_single",
        airline: airline.airline,
        query: `According to the CheapOair baggage fees page, what carry-on size does ${airline.short} list?`,
        pattern: airline.size,
      }),
      makeDirectoryCase({
        id: `directory_${airline.id}_notes`,
        category: "directory_single",
        airline: airline.airline,
        query: `According to the CheapOair baggage fees page, what personal item note does ${airline.short} list for carry-on baggage?`,
        pattern: airline.note,
      }),
    );
  }

  return cases;
}

function buildDirectoryComparisonCases() {
  const baseFilter = {
    sourceType: "baggage_directory",
    domain: "www.cheapoair.com",
  };

  return [
    {
      id: "directory_compare_aegean_air_india_weight",
      category: "directory_compare",
      query: "Compare Aegean Airlines and Air India carry-on weight according to the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Aegean Airlines/iu, /Air India/iu, /8 kg|17 lb/iu, /7kg|17lb/iu],
      },
    },
    {
      id: "directory_compare_air_canada_air_nz_notes",
      category: "directory_compare",
      query: "Compare Air Canada and Air New Zealand personal item notes on the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Air Canada/iu, /Air New Zealand/iu, /Personal Article/iu, /slim laptop bag/iu],
      },
    },
    {
      id: "directory_compare_air_france_air_serbia_size",
      category: "directory_compare",
      query: "Compare Air France and Air Serbia carry-on size listings on the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Air France/iu, /Air Serbia/iu, /55 x 35 x 25/iu, /40 x 23 x 55/iu],
      },
    },
    {
      id: "directory_compare_aeromexico_air_europa_weight",
      category: "directory_compare",
      query: "Compare Aeromexico and Air Europa carry-on weight according to the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Aeromexico/iu, /Air Europa/iu, /10 kg/iu],
      },
    },
    {
      id: "directory_compare_air_baltic_air_astana_notes",
      category: "directory_compare",
      query: "Compare Air Baltic and Air Astana carry-on notes according to the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Air Baltic/iu, /Air Astana/iu, /total combined weight/iu, /small handbag or laptop bag/iu],
      },
    },
    {
      id: "directory_compare_air_india_air_nz_notes",
      category: "directory_compare",
      query: "Compare Air India and Air New Zealand personal item notes on the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Air India/iu, /Air New Zealand/iu, /handbag\/briefcase\/laptop/iu, /slim laptop bag/iu],
      },
    },
    {
      id: "directory_compare_air_canada_air_france_size",
      category: "directory_compare",
      query: "Compare Air Canada and Air France carry-on size entries on the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Air Canada/iu, /Air France/iu, /55 x 40 x 23/iu, /55 x 35 x 25/iu],
      },
    },
    {
      id: "directory_compare_aegean_aeromexico_notes",
      category: "directory_compare",
      query: "Compare Aegean Airlines and Aeromexico carry-on notes on the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Aegean Airlines/iu, /Aeromexico/iu, /thin laptop case/iu, /Briefcases, purses, computers/iu],
      },
    },
    {
      id: "directory_compare_air_serbia_air_europa_weight",
      category: "directory_compare",
      query: "Compare Air Serbia and Air Europa carry-on weight according to the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Air Serbia/iu, /Air Europa/iu, /17lb \/ 8kg/iu, /20lb \/ 10kg/iu],
      },
    },
    {
      id: "directory_compare_air_astana_air_france_size",
      category: "directory_compare",
      query: "Compare Air Astana and Air France carry-on size according to the CheapOair baggage fees page.",
      topK: 8,
      filter: baseFilter,
      expect: {
        minResults: 2,
        requiredTextPatterns: [/Air Astana/iu, /Air France/iu, /56 x 45 x 25/iu, /55 x 35 x 25/iu],
      },
    },
  ];
}

function buildDirectoryLinkedPolicyCases() {
  return [
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_air_canada_first_bag",
      query:
        "According to the CheapOair baggage fees page, what is Air Canada first checked bag policy?",
      airlinePattern: /Air Canada/iu,
      pattern: /\bChecked Baggage\b|\bmax\. weight per bag\b|\bAeroplan 25K\b/iu,
    }),
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_air_india_first_bag",
      query:
        "According to the CheapOair baggage fees page, what is Air India first checked bag policy?",
      airlinePattern: /Air India|@airindia/iu,
      pattern: /\bDomestic flights\b|\b15 kg\/33 lb\b|\b25 kg\/55 lb\b/iu,
    }),
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_united_first_bag",
      query:
        "According to the CheapOair baggage fees page, what is United Airlines first checked bag policy within USA?",
      airlinePattern: /United/iu,
      pattern: /\bPrepay for your checked bags\b|\bwithin the U\.S\.\b|\bchecked bags online\b/iu,
    }),
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_westjet_first_bag",
      query:
        "According to the CheapOair baggage fees page, what is WestJet first checked bag policy?",
      airlinePattern: /WestJet/iu,
      pattern: /\bFirst piece on WestJet\b|\b50 lbs\. \(23 kg\)\b|\bMay apply\b/iu,
    }),
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_british_airways_first_bag",
      query:
        "According to the CheapOair baggage fees page, what is British Airways first checked bag policy?",
      airlinePattern: /British Airways/iu,
      pattern: /\bExtra, heavy or large bags\?\b|\b23kg baggage weight limit\b|\bextra hold bag\b/iu,
    }),
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_air_france_first_bag",
      query:
        "According to the CheapOair baggage fees page, what is Air France first checked bag policy?",
      airlinePattern: /Air France/iu,
      pattern: /\bhold baggage\b|\bchecked baggage\b|\bbaggage allowance\b/iu,
    }),
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_aegean_first_bag",
      query:
        "According to the CheapOair baggage fees page, what is Aegean Airlines first checked bag policy?",
      airlinePattern: /Aegean Airlines/iu,
      pattern: /\bchecked baggage\b|\b32 kilos\b|\bbaggage allowance\b/iu,
    }),
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_air_canada_additional_policy",
      query:
        "According to the CheapOair baggage fees page, what additional checked baggage rules does Air Canada mention?",
      airlinePattern: /Air Canada/iu,
      pattern: /\boverweight\/oversized\b|\b158 cm \(62in\)\b|\bcharges\b/iu,
    }),
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_united_second_bag",
      query:
        "According to the CheapOair baggage fees page, what is United Airlines second checked bag policy?",
      airlinePattern: /United/iu,
      pattern: /\bchecked bag fee calculator\b|\bchecked bags online\b|\bwithin the U\.S\.\b/iu,
    }),
    makeDirectoryLinkedPolicyCase({
      id: "directory_linked_westjet_additional_policy",
      query:
        "According to the CheapOair baggage fees page, what additional baggage policy does WestJet mention?",
      airlinePattern: /WestJet/iu,
      pattern: /\bGuests are allowed to check up to 4 bags\b|\boverweight or oversized baggage\b|\bWestJet Cargo\b/iu,
    }),
  ];
}

function buildNegativeCases() {
  const baseFilter = { sourceType: "airline_policy" };

  return [
    { id: "negative_aer_lingus_1", query: "What is Aer Lingus carry-on baggage policy?", airline: "Aer Lingus" },
    { id: "negative_aer_lingus_2", query: "What does Aer Lingus say about checked baggage?", airline: "Aer Lingus" },
    { id: "negative_aerolineas_1", query: "What is Aerolineas Argentinas baggage policy?", airline: "Aerolineas Argentinas" },
    { id: "negative_aerolineas_2", query: "What is Aerolineas Argentinas carry-on baggage policy?", airline: "Aerolineas Argentinas" },
    { id: "negative_mystery_air", query: "What is Mystery Air carry-on baggage policy?", airline: "Mystery Air" },
    { id: "negative_galactic_air", query: "What is Galactic Air carry-on baggage policy?", airline: "Galactic Air" },
    { id: "negative_fantasy_airways", query: "What is Fantasy Airways baggage policy?", airline: "Fantasy Airways" },
    { id: "negative_northwind_skies", query: "What is Northwind Skies baggage policy?", airline: "Northwind Skies" },
    { id: "negative_blue_comet", query: "What is Blue Comet baggage policy?", airline: "Blue Comet" },
    { id: "negative_orbit_express", query: "What is Orbit Express carry-on baggage policy?", airline: "Orbit Express" },
  ].map((entry) => ({
    id: entry.id,
    category: "negative",
    query: entry.query,
    topK: 6,
    filter: {
      ...baseFilter,
      airline: entry.airline,
    },
    expect: {
      maxResults: 0,
    },
  }));
}

function buildCases() {
  const cases = [
    ...buildPrivacySingleCases(),
    ...buildPrivacyMultiCases(),
    ...buildOfficialPolicyCases(),
    ...buildDirectorySingleCases(),
    ...buildDirectoryComparisonCases(),
    ...buildDirectoryLinkedPolicyCases(),
    ...buildNegativeCases(),
  ];

  if (cases.length !== 110) {
    throw new Error(`Expected 110 cases, built ${cases.length}.`);
  }

  return cases;
}

async function indexArtifacts(qdrantService, openAiService, artifacts) {
  const records = artifacts.records || artifacts.chunks;
  const eligible = records.filter((record) => record.retrievalAllowed);
  if (!eligible.length) {
    return {
      chunkCount: artifacts.chunks.length,
      rowCount: artifacts.directoryRows?.length || 0,
      indexedChunkCount: 0,
      sourceType: artifacts.document.sourceType,
      url: artifacts.document.url,
    };
  }

  const vectors = await openAiService.createEmbeddings(
    eligible.map((record) => record.embeddingText || record.text),
  );
  await qdrantService.ensureCollection(vectors[0].length);
  await qdrantService.deleteDocument(artifacts.document.docId);
  await qdrantService.upsertRecords(eligible, vectors);

  return {
    chunkCount: artifacts.chunks.length,
    rowCount: artifacts.directoryRows?.length || 0,
    indexedChunkCount: eligible.length,
    sourceType: artifacts.document.sourceType,
    url: artifacts.document.url,
  };
}

async function indexRootDocuments(qdrantService, openAiService, evalConfig) {
  const rawDir = evalConfig.paths.rawDir;
  const fileNames = await readdir(rawDir);
  const jsonFiles = fileNames.filter((fileName) => fileName.endsWith(".json"));
  const indexed = [];

  for (const fileName of jsonFiles) {
    const rawDoc = await readJson(join(rawDir, fileName));
    if (!ROOT_URL_PATTERNS.some((pattern) => pattern.test(rawDoc.url))) {
      continue;
    }

    const artifacts = buildVectorArtifacts(rawDoc, evalConfig.chunking);
    const summary = await indexArtifacts(qdrantService, openAiService, artifacts);
    indexed.push({
      fileName,
      ...summary,
    });
  }

  return indexed;
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
    "# Complex KB Evaluation Report",
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Output dir: ${report.outputDir}`,
    `- Qdrant collection: ${report.qdrantCollection}`,
    `- Root docs indexed: ${report.indexing.rootIndexedCount}`,
    `- Run docs indexed: ${report.indexing.runIndexedCount}`,
    "",
    "## Strategy Summary",
    "",
  ];

  for (const [strategy, details] of Object.entries(report.strategies)) {
    lines.push(`### ${strategy}`);
    lines.push("");
    lines.push(`- Total cases: ${details.summary.total}`);
    lines.push(`- Passed: ${details.summary.passed}`);
    lines.push(`- Failed: ${details.summary.failed}`);
    lines.push("- Category summary:");
    for (const [category, stats] of Object.entries(details.byCategory)) {
      lines.push(
        `  - ${category}: ${stats.passed}/${stats.total} passed (${stats.failed} failed)`,
      );
    }
    lines.push("");
  }

  lines.push("## Failed Cases");
  lines.push("");

  for (const [strategy, details] of Object.entries(report.strategies)) {
    lines.push(`### ${strategy}`);
    lines.push("");
    const failed = details.results.filter((item) => !item.pass);
    if (!failed.length) {
      lines.push("- none");
      lines.push("");
      continue;
    }

    for (const item of failed.slice(0, 25)) {
      lines.push(`#### ${item.id} (${item.category})`);
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
  const outDir = resolve(process.cwd(), args.outDir || "data/evals/complex-latest");
  const runDir = resolve(
    process.cwd(),
    args.runDir ||
      "data/crawl4ai/runs/2026-03-05T10-08-19-582Z-baggage-fees-all-links",
  );
  const strategies = ["hyde"];

  if (!baseConfig.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required for complex KB evaluation.");
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const evalConfig = buildEvalConfig(outDir);
  const openAiService = new OpenAIService(evalConfig);
  const qdrantService = new QdrantService(evalConfig);
  const runImportService = new RunImportService({
    config: evalConfig,
    openAiService,
    qdrantService,
  });
  const retrievalService = new RetrievalService({
    config: evalConfig,
    openAiService,
    qdrantService,
  });

  await qdrantService.deleteCollection();

  console.log(`Indexing root docs from ${evalConfig.paths.rawDir}`);
  const rootIndexed = await indexRootDocuments(qdrantService, openAiService, evalConfig);

  console.log(`Importing deep crawl run from ${runDir}`);
  const runImport = await runImportService.importRunDirectory(runDir);

  const cases = buildCases();
  console.log(`Built ${cases.length} complex cases`);

  const strategyResults = {};

  for (const strategy of strategies) {
    const results = [];

    for (const testCase of cases) {
      console.log(`Running case ${testCase.id} with ${strategy}`);
      const hits = await retrievalService.retrieve(testCase.query, {
        topK: testCase.topK,
        filter: testCase.filter,
      });
      const evaluation = evaluateCase(testCase, hits);

      results.push({
        id: testCase.id,
        category: testCase.category,
        query: testCase.query,
        filter: testCase.filter,
        strategy,
        pass: evaluation.pass,
        failures: evaluation.failures,
        resultCount: hits.length,
        topHits: hits.slice(0, 4).map(summarizeHit),
      });
    }

    strategyResults[strategy] = {
      summary: {
        total: results.length,
        passed: results.filter((item) => item.pass).length,
        failed: results.filter((item) => !item.pass).length,
      },
      byCategory: summarizeByCategory(results),
      results,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    outputDir: outDir,
    qdrantCollection: evalConfig.qdrantCollection,
    strategies: strategyResults,
    indexing: {
      rootIndexedCount: rootIndexed.length,
      rootIndexed,
      runIndexedCount: runImport.indexed,
      runFailedCount: runImport.failed,
    },
  };

  const jsonPath = join(outDir, "report.json");
  const mdPath = join(outDir, "report.md");

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, renderMarkdown(report), "utf8");

  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(strategyResults).map(([strategy, details]) => [
          strategy,
          {
            summary: details.summary,
            byCategory: details.byCategory,
          },
        ]),
      ),
      null,
      2,
    ),
  );
  console.log(`Report written to ${jsonPath}`);
  console.log(`Markdown written to ${mdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
