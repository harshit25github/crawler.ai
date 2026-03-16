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
} from "../src/indexing.js";
import { RetrievalService } from "../src/retrivel.js";

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
    qdrantCollection: `url_kb_eval_${Date.now()}`,
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

function includesText(results, pattern) {
  return results.some((result) => pattern.test(result.text || ""));
}

function includesSection(results, pattern) {
  return results.some((result) => pattern.test(result.sectionTitle || ""));
}

function includesAirline(results, pattern) {
  return results.some((result) => pattern.test(result.airlineName || ""));
}

function evaluateCase(testCase, results) {
  const failures = [];

  if (typeof testCase.expect.minResults === "number") {
    if (results.length < testCase.expect.minResults) {
      failures.push(
        `Expected at least ${testCase.expect.minResults} results, got ${results.length}.`,
      );
    }
  }

  if (typeof testCase.expect.maxResults === "number") {
    if (results.length > testCase.expect.maxResults) {
      failures.push(
        `Expected at most ${testCase.expect.maxResults} results, got ${results.length}.`,
      );
    }
  }

  if (
    testCase.expect.sectionPattern &&
    !includesSection(results, testCase.expect.sectionPattern)
  ) {
    failures.push(
      `Did not retrieve expected section matching ${testCase.expect.sectionPattern}.`,
    );
  }

  if (testCase.expect.textPattern && !includesText(results, testCase.expect.textPattern)) {
    failures.push(
      `Did not retrieve expected text matching ${testCase.expect.textPattern}.`,
    );
  }

  if (
    testCase.expect.airlinePattern &&
    !includesAirline(results, testCase.expect.airlinePattern)
  ) {
    failures.push(
      `Did not retrieve expected airline matching ${testCase.expect.airlinePattern}.`,
    );
  }

  if (testCase.expect.requiredAirlines) {
    for (const pattern of testCase.expect.requiredAirlines) {
      if (!includesAirline(results, pattern)) {
        failures.push(`Missing airline matching ${pattern}.`);
      }
    }
  }

  if (
    testCase.expect.absentAirlinePattern &&
    includesAirline(results, testCase.expect.absentAirlinePattern)
  ) {
    failures.push(
      `Unexpected airline matched ${testCase.expect.absentAirlinePattern}.`,
    );
  }

  return {
    pass: failures.length === 0,
    failures,
  };
}

function buildCases() {
  return [
    {
      id: "privacy_personal_information",
      query: "What personal information does CheapOair collect?",
      filter: {
        sourceType: "privacy_policy",
        domain: "www.cheapoair.com",
      },
      topK: 6,
      expect: {
        minResults: 1,
        sectionPattern: /PERSONAL INFORMATION/u,
        textPattern: /\b(name|email|phone|payment)\b/iu,
      },
    },
    {
      id: "privacy_opt_out_marketing",
      query: "How can I opt out of marketing emails from CheapOair?",
      filter: {
        sourceType: "privacy_policy",
        domain: "www.cheapoair.com",
      },
      topK: 6,
      expect: {
        minResults: 1,
        sectionPattern: /Opt-Out of Marketing Emails/iu,
        textPattern: /\bopt-out\b|\bmarketing-related emails\b/iu,
      },
    },
    {
      id: "privacy_security_limits",
      query: "Does CheapOair guarantee complete security of personal information?",
      filter: {
        sourceType: "privacy_policy",
        domain: "www.cheapoair.com",
      },
      topK: 6,
      expect: {
        minResults: 1,
        sectionPattern: /Security/iu,
        textPattern: /\bUnfortunately\b|\bcannot guarantee\b|\bguaranteed to be secure\b/iu,
      },
    },
    {
      id: "privacy_non_us_residents",
      query: "What notice applies to non-US residents in the privacy policy?",
      filter: {
        sourceType: "privacy_policy",
        domain: "www.cheapoair.com",
      },
      topK: 6,
      expect: {
        minResults: 1,
        sectionPattern: /Non-US Residents/iu,
      },
    },
    {
      id: "privacy_canadian_rights",
      query: "What does CheapOair say about Canadian privacy rights?",
      filter: {
        sourceType: "privacy_policy",
        domain: "www.cheapoair.com",
      },
      topK: 6,
      expect: {
        minResults: 1,
        sectionPattern: /Canadian Privacy Rights/iu,
      },
    },
    {
      id: "baggage_delta_carry_on",
      query: "What is Delta carry-on baggage policy?",
      filter: {
        sourceType: "airline_policy",
      },
      topK: 6,
      expect: {
        minResults: 1,
        airlinePattern: /Delta/iu,
        textPattern: /\bcarry-on\b|\bpersonal item\b/iu,
      },
    },
    {
      id: "baggage_united_size_limits",
      query: "What are United carry-on size limits?",
      filter: {
        sourceType: "airline_policy",
      },
      topK: 6,
      expect: {
        minResults: 1,
        airlinePattern: /United/iu,
        textPattern: /9 in x 14 in x 22 in|size limits/iu,
      },
    },
    {
      id: "baggage_compare_delta_united",
      query: "Compare Delta and United carry-on baggage rules.",
      filter: {
        sourceType: "airline_policy",
      },
      topK: 8,
      expect: {
        minResults: 2,
        requiredAirlines: [/Delta/iu, /United/iu],
      },
    },
    {
      id: "baggage_british_airways_hand_baggage",
      query: "What does British Airways say about hand baggage allowances?",
      filter: {
        sourceType: "airline_policy",
      },
      topK: 6,
      expect: {
        minResults: 1,
        airlinePattern: /British Airways/iu,
      },
    },
    {
      id: "baggage_checked_bag_united",
      query: "What does United say about checked bag charges?",
      filter: {
        sourceType: "airline_policy",
      },
      topK: 6,
      expect: {
        minResults: 1,
        airlinePattern: /United/iu,
        textPattern: /\bcheck(?:ed)? bag\b|\bcharges depend\b|\bpay a fee\b/iu,
      },
    },
    {
      id: "baggage_negative_aer_lingus",
      query: "What is Aer Lingus carry-on baggage policy?",
      filter: {
        sourceType: "airline_policy",
        airline: "Aer Lingus",
      },
      topK: 6,
      expect: {
        maxResults: 0,
      },
    },
    {
      id: "baggage_negative_aerolineas_argentinas",
      query: "What is Aerolineas Argentinas baggage policy?",
      filter: {
        sourceType: "airline_policy",
        airline: "Aerolineas Argentinas",
      },
      topK: 6,
      expect: {
        maxResults: 0,
      },
    },
  ];
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
  };
}

async function indexRawDocuments(qdrantService, openAiService, evalConfig) {
  const rawDir = evalConfig.paths.rawDir;
  const fileNames = await readdir(rawDir);
  const jsonFiles = fileNames.filter((fileName) => fileName.endsWith(".json"));
  const indexed = [];

  for (const fileName of jsonFiles) {
    const rawDoc = await readJson(join(rawDir, fileName));
    const artifacts = buildVectorArtifacts(rawDoc, evalConfig.chunking);
    const summary = await indexArtifacts(qdrantService, openAiService, artifacts);
    indexed.push({
      fileName,
      ...summary,
    });
  }

  return indexed;
}

function renderMarkdown(report) {
  const lines = [
    "# KB Evaluation Report",
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Output dir: ${report.outputDir}`,
    `- Qdrant collection: ${report.qdrantCollection}`,
    `- Indexed raw docs: ${report.indexing.rawIndexedCount}`,
    `- Indexed run docs: ${report.indexing.runIndexedCount}`,
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
    lines.push("");
  }

  lines.push("## Cases");
  lines.push("");

  for (const [strategy, details] of Object.entries(report.strategies)) {
    lines.push(`### ${strategy}`);
    lines.push("");

    for (const item of details.results) {
      lines.push(`#### ${item.id}`);
      lines.push("");
      lines.push(`- Query: ${item.query}`);
      lines.push(`- Pass: ${item.pass ? "yes" : "no"}`);
      lines.push(`- Result count: ${item.resultCount}`);

      if (item.failures.length) {
        lines.push(`- Failures: ${item.failures.join(" | ")}`);
      }

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
  const outDir = resolve(process.cwd(), args.outDir || "data/evals/latest");
  const runDir = resolve(
    process.cwd(),
    args.runDir ||
      "data/crawl4ai/runs/2026-03-05T10-08-19-582Z-baggage-fees-all-links",
  );

  if (!baseConfig.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required for vector KB evaluation.");
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

  console.log(`Indexing raw docs from ${evalConfig.paths.rawDir}`);
  const rawIndexed = await indexRawDocuments(
    qdrantService,
    openAiService,
    evalConfig,
  );

  console.log(`Importing deep crawl run from ${runDir}`);
  const runImport = await runImportService.importRunDirectory(runDir);

  const cases = buildCases();
  const strategies = {};

  for (const strategy of ["hyde"]) {
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
        query: testCase.query,
        filter: testCase.filter,
        strategy,
        pass: evaluation.pass,
        failures: evaluation.failures,
        resultCount: hits.length,
        topHits: hits.slice(0, 4).map(summarizeHit),
      });
    }

    strategies[strategy] = {
      summary: {
        total: results.length,
        passed: results.filter((item) => item.pass).length,
        failed: results.filter((item) => !item.pass).length,
      },
      results,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    outputDir: outDir,
    qdrantCollection: evalConfig.qdrantCollection,
    indexing: {
      rawIndexedCount: rawIndexed.length,
      rawIndexed,
      runIndexedCount: runImport.indexed,
      runFailedCount: runImport.failed,
    },
    strategies,
  };

  const jsonPath = join(outDir, "report.json");
  const mdPath = join(outDir, "report.md");

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, renderMarkdown(report), "utf8");

  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(strategies).map(([strategy, details]) => [
          strategy,
          details.summary,
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
