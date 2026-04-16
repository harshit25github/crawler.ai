import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const API_ROUTE = "/api/chat";

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

function normalizeText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function summarizeCitations(citations = []) {
  return citations.map((citation) => ({
    citationIndex: citation.citationIndex,
    title: citation.title || null,
    url: citation.url || null,
  }));
}

function summarizeChunks(chunks = []) {
  return chunks.map((chunk) => ({
    citationIndex: chunk.citationIndex,
    sourceType: chunk.sourceType || null,
    airlineName: chunk.airlineName || null,
    sectionTitle: chunk.sectionTitle || null,
    sectionPath: chunk.sectionPath || [],
    url: chunk.url || null,
    score: chunk.score || null,
    preview: normalizeText(chunk.text || "").slice(0, 260),
  }));
}

function collectHaystack(responseBody = {}) {
  const parts = [responseBody.answer || ""];

  for (const citation of responseBody.citations || []) {
    parts.push(citation.title || "");
    parts.push(citation.url || "");
  }

  for (const chunk of responseBody.chunks || []) {
    parts.push(chunk.title || "");
    parts.push(chunk.sectionTitle || "");
    parts.push((chunk.sectionPath || []).filter(Boolean).join(" "));
    parts.push(chunk.airlineName || "");
    parts.push(chunk.url || "");
    parts.push(chunk.text || "");
  }

  return normalizeText(parts.join("\n"));
}

function evaluateCase(testCase, responseBody, statusCode) {
  const haystack = collectHaystack(responseBody);
  const matchedPatterns = [];
  const missingPatterns = [];

  for (const pattern of testCase.expectedPatterns) {
    if (pattern.test(haystack)) {
      matchedPatterns.push(pattern.toString());
    } else {
      missingPatterns.push(pattern.toString());
    }
  }

  const citationCount = Array.isArray(responseBody.citations)
    ? responseBody.citations.length
    : 0;
  const chunkCount = Array.isArray(responseBody.chunks) ? responseBody.chunks.length : 0;
  const answer = normalizeText(responseBody.answer || "");
  const insufficientEvidence =
    /could not find relevant chunks|does not contain enough verified context|insufficient/iu.test(
      answer,
    );

  let rating = "fail";
  if (
    statusCode === 200 &&
    citationCount > 0 &&
    !insufficientEvidence &&
    missingPatterns.length === 0
  ) {
    rating = "pass";
  } else if (
    statusCode === 200 &&
    citationCount > 0 &&
    matchedPatterns.length > 0
  ) {
    rating = "partial";
  }

  const numericScore = rating === "pass" ? 1 : rating === "partial" ? 0.5 : 0;

  return {
    rating,
    numericScore,
    matchedPatterns,
    missingPatterns,
    citationCount,
    chunkCount,
    insufficientEvidence,
  };
}

function scoreToGrade(scorePercent) {
  if (scorePercent >= 90) {
    return "A";
  }
  if (scorePercent >= 80) {
    return "B";
  }
  if (scorePercent >= 70) {
    return "C";
  }
  if (scorePercent >= 60) {
    return "D";
  }
  return "F";
}

function buildCases() {
  return [
    {
      id: "privacy_collect",
      category: "privacy",
      query: "What personal information does CheapOair collect?",
      expectedPatterns: [/\bpersonal information\b|\bname\b|\bemail\b/iu, /\bpayment\b|\bcredit\b|\bpassport\b/iu],
    },
    {
      id: "privacy_opt_out",
      category: "privacy",
      query: "How can I opt out of CheapOair marketing emails?",
      expectedPatterns: [/\bopt.?out\b|\bunsubscribe\b/iu, /\bmarketing\b/iu],
    },
    {
      id: "privacy_security",
      category: "privacy",
      query: "Does CheapOair guarantee complete security of personal information?",
      expectedPatterns: [/\bsecurity\b/iu, /\bcannot be guaranteed\b|\b100% secure\b|\bno data transmission\b/iu],
    },
    {
      id: "privacy_retention",
      category: "privacy",
      query: "What does CheapOair say about retention period for personal information?",
      expectedPatterns: [/\bretention\b|\bretain\b/iu],
    },
    {
      id: "privacy_canadian_rights",
      category: "privacy",
      query: "What rights do Canadian users have under CheapOair privacy policy?",
      expectedPatterns: [/\bcanadian\b/iu, /\bprivacy rights\b/iu],
    },
    {
      id: "privacy_non_us",
      category: "privacy",
      query: "What notice applies to non-US residents in CheapOair privacy policy?",
      expectedPatterns: [/\bnon-us residents\b|\boutside of the u\.s\b/iu, /\btransferred\b|\btransfer\b/iu],
    },
    {
      id: "privacy_disclosure",
      category: "privacy",
      query: "How may CheapOair disclose personal information?",
      expectedPatterns: [/\bdisclose\b|\bdisclosed\b|\btransferred\b/iu],
    },
    {
      id: "privacy_third_party",
      category: "privacy",
      query: "What does the privacy policy say about third-party services?",
      expectedPatterns: [/\bthird-party services\b|\bthird parties\b/iu],
    },
    {
      id: "cookie_define",
      category: "cookie",
      query: "What is a cookie according to CheapOair cookie policy?",
      expectedPatterns: [/\bsmall text file\b/iu, /\bremember your actions\b|\bpreferences\b/iu],
    },
    {
      id: "cookie_types",
      category: "cookie",
      query: "What types of cookies does CheapOair say it uses?",
      expectedPatterns: [/\bstrictly necessary\b|\bperformance\b|\bfunctional\b|\badvertising\b/iu],
    },
    {
      id: "cookie_first_third_party",
      category: "cookie",
      query: "How does CheapOair describe first-party and third-party cookies?",
      expectedPatterns: [/\b1st party\b|\bfirst-party\b/iu, /\b3rd party\b|\bthird-party\b/iu],
    },
    {
      id: "cookie_control",
      category: "cookie",
      query: "How can I control or disable cookies on CheapOair?",
      expectedPatterns: [/\bbrowser\b/iu, /\bdelete\b|\bprevent\b|\bopt-out\b|\bcontrol cookies\b/iu],
    },
    {
      id: "cookie_advertising",
      category: "cookie",
      query: "Does CheapOair use advertising or targeted cookies?",
      expectedPatterns: [/\badvertising cookies\b|\btargeted advertisements\b|\bonline behavioural advertising\b/iu],
    },
    {
      id: "terms_arbitration",
      category: "terms",
      query: "Do CheapOair terms require mandatory arbitration?",
      expectedPatterns: [/\barbitration\b|\bbinding arbitration\b/iu],
    },
    {
      id: "terms_class_action",
      category: "terms",
      query: "Is there a class action waiver in CheapOair terms?",
      expectedPatterns: [/\bclass action\b|\bclass, mass, representative\b/iu, /\bwaiv/iu],
    },
    {
      id: "terms_jury_waiver",
      category: "terms",
      query: "Do CheapOair terms waive trial by jury?",
      expectedPatterns: [/\bjury\b/iu, /\bwaiv/iu],
    },
    {
      id: "terms_cancel_exchange",
      category: "terms",
      query: "What do CheapOair terms say about cancel and exchange for airline tickets?",
      expectedPatterns: [/\bcancel\b|\bcancellation\b/iu, /\bnon-refundable\b|\bcredit\b|\bexchange\b/iu],
    },
    {
      id: "terms_refund",
      category: "terms",
      query: "What does CheapOair say about cancel and refund eligibility?",
      expectedPatterns: [/\brefund\b/iu, /\b24 hours\b|\bno show\b|\bwaivers\b/iu],
    },
    {
      id: "terms_price_guarantee",
      category: "terms",
      query: "Does CheapOair guarantee the quoted airfare after payment is accepted?",
      expectedPatterns: [/\bprice guarantee\b|\bquoted price\b/iu, /\bpayment\b/iu],
    },
    {
      id: "terms_baggage_fees",
      category: "terms",
      query: "What do CheapOair terms say about baggage policy and fees?",
      expectedPatterns: [/\bbaggage policy and fees\b|\bbaggage fees\b/iu, /\bfirst bag checked-in\b|\bpaid directly to airline\b|\b\$15\b/iu],
    },
    {
      id: "terms_connecting_baggage",
      category: "terms",
      query: "What do CheapOair terms say about baggage on connecting flights?",
      expectedPatterns: [/\bconnecting flights\b/iu, /\breclaim your bags\b|\bcheck-in again\b/iu],
    },
    {
      id: "terms_schedule_changes",
      category: "terms",
      query: "What do CheapOair terms say about airline schedule changes or flight cancellations?",
      expectedPatterns: [/\bschedule changes\b|\bflight cancellations\b/iu],
    },
    {
      id: "terms_visa_entry",
      category: "terms",
      query: "What do CheapOair terms say about passport, visa, and entry requirements?",
      expectedPatterns: [/\bvisa\b|\bentry requirements\b|\btravel documents\b/iu],
    },
    {
      id: "terms_hazardous_materials",
      category: "terms",
      query: "What do CheapOair terms say about hazardous materials in luggage?",
      expectedPatterns: [/\bhazardous materials\b/iu, /\bexplosives\b|\bflammable\b|\bcompressed gases\b/iu],
    },
    {
      id: "baggage_delta_carry_on",
      category: "baggage",
      query: "What is Delta carry-on baggage policy? Include size, weight and cost.",
      expectedPatterns: [/\bdelta\b/iu, /\bcarry-on\b|\bpersonal item\b/iu],
    },
    {
      id: "baggage_turkish_checked",
      category: "baggage",
      query: "What are Turkish Airlines checked baggage rules?",
      expectedPatterns: [/\bturkish\b/iu, /\bchecked\b|\bbaggage\b|\bbag\b/iu],
    },
    {
      id: "baggage_american_route",
      category: "baggage",
      query: "I have a flight from NYC to LAX on American Airlines in economy class. What will be the baggage policy?",
      expectedPatterns: [/\bamerican airlines\b/iu, /\bcarry-on\b|\bchecked\b|\bbaggage\b/iu],
    },
    {
      id: "baggage_united_checked_bags",
      category: "baggage",
      query: "What does United say about first checked bag and second checked bag charges?",
      expectedPatterns: [/\bunited\b/iu, /\bfirst checked bag\b|\bsecond checked bag\b|\b1st bag\b|\b2nd bag\b/iu],
    },
    {
      id: "baggage_aer_lingus",
      category: "baggage",
      query: "I am a USA citizen, show Aer Lingus carry-on rules.",
      expectedPatterns: [/\baer lingus\b/iu, /\bcarry-on\b|\bpersonal item\b|\bhand baggage\b/iu],
    },
    {
      id: "baggage_air_tahiti_nui",
      category: "baggage",
      query: "I wanna travel from USA to France. What is carry-on baggage policy for Air Tahiti Nui?",
      expectedPatterns: [/\bair tahiti nui\b/iu, /\bcarry-on\b|\bcarry on\b|\bpersonal item\b/iu],
    },
    {
      id: "baggage_compare_delta_united",
      category: "baggage",
      query: "Compare Delta and United carry-on baggage rules.",
      expectedPatterns: [/\bdelta\b/iu, /\bunited\b/iu, /\bcarry-on\b|\bpersonal item\b/iu],
    },
  ];
}

async function requestJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let parsedBody;
  try {
    parsedBody = await response.json();
  } catch {
    parsedBody = {
      error: "Response was not valid JSON.",
    };
  }

  return {
    statusCode: response.status,
    body: parsedBody,
  };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function buildSummaryMarkdown({
  reportPath,
  apiBaseUrl,
  totalCases,
  counts,
  overallPercent,
  grade,
  results,
}) {
  const lines = [
    "# Mixed /api/chat Evaluation",
    "",
    `- API base URL: \`${apiBaseUrl}\``,
    `- Report JSON: \`${reportPath}\``,
    `- Total cases: \`${totalCases}\``,
    `- Pass: \`${counts.pass}\``,
    `- Partial: \`${counts.partial}\``,
    `- Fail: \`${counts.fail}\``,
    `- Overall score: \`${overallPercent.toFixed(1)}%\``,
    `- Grade: \`${grade}\``,
    "",
    "## Worst Cases",
    "",
  ];

  const worstCases = [...results]
    .sort((left, right) => left.numericScore - right.numericScore)
    .slice(0, 10);

  for (const item of worstCases) {
    lines.push(`### ${item.caseId}`);
    lines.push(`- Category: \`${item.category}\``);
    lines.push(`- Rating: \`${item.rating}\``);
    lines.push(`- Query: ${item.query}`);
    lines.push(`- Missing patterns: ${item.missingPatterns.join(", ") || "none"}`);
    lines.push(`- Citation count: \`${item.citationCount}\``);
    lines.push(`- Chunk count: \`${item.chunkCount}\``);
    lines.push(`- Answer: ${item.answer || "(empty)"}`);
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiBaseUrl = args.apiBaseUrl || "http://localhost:3000";
  const outDir = resolve(args.outDir || join("data", "evals", "chat-mixed-latest"));
  const reset = args.reset !== "false";
  const cases = buildCases();

  if (reset) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  const results = [];

  for (const [index, testCase] of cases.entries()) {
    const startedAt = Date.now();
    console.log(`[${index + 1}/${cases.length}] ${testCase.id}`);

    const { statusCode, body } = await requestJson(`${apiBaseUrl}${API_ROUTE}`, {
      query: testCase.query,
    });

    const durationMs = Date.now() - startedAt;
    const evaluation = evaluateCase(testCase, body, statusCode);

    results.push({
      caseId: testCase.id,
      category: testCase.category,
      query: testCase.query,
      statusCode,
      durationMs,
      rating: evaluation.rating,
      numericScore: evaluation.numericScore,
      matchedPatterns: evaluation.matchedPatterns,
      missingPatterns: evaluation.missingPatterns,
      citationCount: evaluation.citationCount,
      chunkCount: evaluation.chunkCount,
      insufficientEvidence: evaluation.insufficientEvidence,
      answer: body.answer || body.error || "",
      citations: summarizeCitations(body.citations),
      chunks: summarizeChunks(body.chunks),
    });
  }

  const counts = {
    pass: results.filter((item) => item.rating === "pass").length,
    partial: results.filter((item) => item.rating === "partial").length,
    fail: results.filter((item) => item.rating === "fail").length,
  };
  const totalNumericScore = results.reduce((sum, item) => sum + item.numericScore, 0);
  const overallPercent = (totalNumericScore / results.length) * 100;
  const grade = scoreToGrade(overallPercent);

  const report = {
    apiBaseUrl,
    route: API_ROUTE,
    totalCases: results.length,
    counts,
    overallPercent,
    grade,
    results,
  };

  const reportPath = join(outDir, "report.json");
  const summaryPath = join(outDir, "summary.md");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    summaryPath,
    `${buildSummaryMarkdown({
      reportPath,
      apiBaseUrl,
      totalCases: results.length,
      counts,
      overallPercent,
      grade,
      results,
    })}\n`,
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        outDir,
        reportPath,
        summaryPath,
        totalCases: results.length,
        counts,
        overallPercent: Number(overallPercent.toFixed(1)),
        grade,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
