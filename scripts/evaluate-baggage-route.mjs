import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { buildApp } from "../src/api/index.js";

const API_ROUTE = "/api/chat/baggage";

const COLUMNS = [
  { key: "caseId", header: "Case ID" },
  { key: "apiRoute", header: "API Route" },
  { key: "route", header: "Route" },
  { key: "origin", header: "Origin" },
  { key: "destination", header: "Destination" },
  { key: "airline", header: "Airline" },
  { key: "cabin", header: "Cabin" },
  { key: "brandName", header: "Brand Name" },
  { key: "payload", header: "Payload Used" },
  { key: "generatedQuery", header: "Query Fed To Agent" },
  { key: "statusCode", header: "Status Code" },
  { key: "durationMs", header: "Duration Ms" },
  { key: "answer", header: "Agent Response" },
  { key: "citationCount", header: "Citation Count" },
  { key: "chunkCount", header: "Chunk Count" },
  { key: "citations", header: "Citations" },
];

const CASES = [
  {
    id: "emirates_nyc_lax_economy",
    payload: {
      origin: "NYC",
      destination: "LAX",
      airline: "Emirates",
      cabin: "economy",
    },
  },
  {
    id: "emirates_nyc_del_economy",
    payload: {
      origin: "NYC",
      destination: "DEL",
      airline: "Emirates",
      cabin: "economy",
    },
  },
  {
    id: "american_nyc_lax_economy",
    payload: {
      origin: "NYC",
      destination: "LAX",
      airline: "American Airlines",
      cabin: "economy",
    },
  },
  {
    id: "american_lax_jfk_business",
    payload: {
      origin: "LAX",
      destination: "JFK",
      airline: "American Airlines",
      cabin: "business",
    },
  },
  {
    id: "delta_atl_sea_basic_economy",
    payload: {
      origin: "ATL",
      destination: "SEA",
      airline: "Delta Air Lines",
      cabin: "economy",
      brandName: "basic economy",
    },
  },
  {
    id: "delta_jfk_lhr_delta_one",
    payload: {
      origin: "JFK",
      destination: "LHR",
      airline: "Delta Air Lines",
      cabin: "business",
      brandName: "Delta One",
    },
  },
  {
    id: "united_sfo_ewr_economy",
    payload: {
      origin: "SFO",
      destination: "EWR",
      airline: "United Airlines",
      cabin: "economy",
    },
  },
  {
    id: "united_ord_fra_premium_economy",
    payload: {
      origin: "ORD",
      destination: "FRA",
      airline: "United Airlines",
      cabin: "premium economy",
    },
  },
  {
    id: "aer_lingus_dub_bos_economy",
    payload: {
      origin: "DUB",
      destination: "BOS",
      airline: "Aer Lingus",
      cabin: "economy",
    },
  },
  {
    id: "aer_lingus_jfk_dub_business",
    payload: {
      origin: "JFK",
      destination: "DUB",
      airline: "Aer Lingus",
      cabin: "business",
    },
  },
  {
    id: "air_tahiti_nui_lax_ppt_economy",
    payload: {
      origin: "LAX",
      destination: "PPT",
      airline: "Air Tahiti Nui",
      cabin: "economy",
    },
  },
  {
    id: "air_tahiti_nui_sfo_cdg_economy",
    payload: {
      origin: "SFO",
      destination: "CDG",
      airline: "Air Tahiti Nui",
      cabin: "economy",
    },
  },
  {
    id: "turkish_jfk_ist_economy",
    payload: {
      origin: "JFK",
      destination: "IST",
      airline: "Turkish Airlines",
      cabin: "economy",
    },
  },
  {
    id: "turkish_ist_del_business",
    payload: {
      origin: "IST",
      destination: "DEL",
      airline: "Turkish Airlines",
      cabin: "business",
    },
  },
  {
    id: "qatar_jfk_doh_economy",
    payload: {
      origin: "JFK",
      destination: "DOH",
      airline: "Qatar Airways",
      cabin: "economy",
    },
  },
  {
    id: "qatar_doh_sin_business",
    payload: {
      origin: "DOH",
      destination: "SIN",
      airline: "Qatar Airways",
      cabin: "business",
    },
  },
  {
    id: "british_airways_jfk_lhr_economy",
    payload: {
      origin: "JFK",
      destination: "LHR",
      airline: "British Airways",
      cabin: "economy",
    },
  },
  {
    id: "british_airways_lhr_del_premium_economy",
    payload: {
      origin: "LHR",
      destination: "DEL",
      airline: "British Airways",
      cabin: "premium economy",
    },
  },
  {
    id: "air_canada_yyz_yvr_economy",
    payload: {
      origin: "YYZ",
      destination: "YVR",
      airline: "Air Canada",
      cabin: "economy",
    },
  },
  {
    id: "air_canada_yul_lax_business",
    payload: {
      origin: "YUL",
      destination: "LAX",
      airline: "Air Canada",
      cabin: "business",
    },
  },
  {
    id: "lufthansa_jfk_muc_economy_light",
    payload: {
      origin: "JFK",
      destination: "MUC",
      airline: "Lufthansa",
      cabin: "economy",
      brandName: "Economy Light",
    },
  },
  {
    id: "lufthansa_muc_del_business",
    payload: {
      origin: "MUC",
      destination: "DEL",
      airline: "Lufthansa",
      cabin: "business",
    },
  },
  {
    id: "air_france_jfk_cdg_economy",
    payload: {
      origin: "JFK",
      destination: "CDG",
      airline: "Air France",
      cabin: "economy",
    },
  },
  {
    id: "air_france_cdg_bom_premium_economy",
    payload: {
      origin: "CDG",
      destination: "BOM",
      airline: "Air France",
      cabin: "premium economy",
    },
  },
  {
    id: "klm_ams_jfk_economy",
    payload: {
      origin: "AMS",
      destination: "JFK",
      airline: "KLM Royal Dutch Airlines",
      cabin: "economy",
    },
  },
  {
    id: "klm_ams_blr_business",
    payload: {
      origin: "AMS",
      destination: "BLR",
      airline: "KLM Royal Dutch Airlines",
      cabin: "business",
    },
  },
  {
    id: "singapore_airlines_sin_jfk_economy",
    payload: {
      origin: "SIN",
      destination: "JFK",
      airline: "Singapore Airlines",
      cabin: "economy",
    },
  },
  {
    id: "singapore_airlines_sin_lax_premium_economy",
    payload: {
      origin: "SIN",
      destination: "LAX",
      airline: "Singapore Airlines",
      cabin: "premium economy",
    },
  },
  {
    id: "etihad_jfk_auh_economy",
    payload: {
      origin: "JFK",
      destination: "AUH",
      airline: "Etihad Airways",
      cabin: "economy",
    },
  },
  {
    id: "etihad_auh_del_business",
    payload: {
      origin: "AUH",
      destination: "DEL",
      airline: "Etihad Airways",
      cabin: "business",
    },
  },
];

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];

    if (!raw.startsWith("--")) {
      continue;
    }

    const [key, value] = raw.slice(2).split("=");
    if (!key) {
      continue;
    }

    if (value !== undefined) {
      args[key] = value;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
      continue;
    }

    args[key] = "true";
  }

  return args;
}

function routeLabel(payload) {
  return `${payload.origin} -> ${payload.destination}`;
}

function jsonCell(value) {
  return JSON.stringify(value ?? null);
}

function textCell(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function buildCsv(rows, columns) {
  return [
    columns.map((column) => csvEscape(column.header)).join(","),
    ...rows.map((row) =>
      columns.map((column) => csvEscape(row[column.key])).join(","),
    ),
  ].join("\n");
}

function buildExcelXml(rows, columns) {
  const headerRow = columns
    .map(
      (column) =>
        `<Cell><Data ss:Type="String">${xmlEscape(column.header)}</Data></Cell>`,
    )
    .join("");
  const dataRows = rows
    .map((row) => {
      const cells = columns
        .map(
          (column) =>
            `<Cell><Data ss:Type="String">${xmlEscape(row[column.key])}</Data></Cell>`,
        )
        .join("");
      return `<Row>${cells}</Row>`;
    })
    .join("\n");

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="Baggage Route Eval">
    <Table>
      <Row>${headerRow}</Row>
      ${dataRows}
    </Table>
  </Worksheet>
</Workbook>
`;
}

async function callBaggageRouteWithApp(app, payload) {
  const response = await app.inject({
    method: "POST",
    url: API_ROUTE,
    payload,
  });
  const body = response.body ? JSON.parse(response.body) : null;

  return {
    statusCode: response.statusCode,
    body,
  };
}

async function callBaggageRouteWithHttp(apiBaseUrl, payload) {
  const response = await fetch(new URL(API_ROUTE, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return {
    statusCode: response.status,
    body,
  };
}

function buildReportRow({ testCase, statusCode, body, error, durationMs }) {
  const payload = testCase.payload;
  const citations = Array.isArray(body?.citations) ? body.citations : [];
  const chunks = Array.isArray(body?.chunks) ? body.chunks : [];

  return {
    caseId: testCase.id,
    apiRoute: API_ROUTE,
    route: routeLabel(payload),
    origin: payload.origin,
    destination: payload.destination,
    airline: payload.airline,
    cabin: payload.cabin,
    brandName: payload.brandName || "",
    payload: jsonCell(payload),
    generatedQuery: body?.generatedQuery || "",
    statusCode: String(statusCode ?? ""),
    durationMs: String(durationMs ?? ""),
    answer: textCell(body?.answer || body?.error || error?.message || ""),
    citationCount: String(citations.length),
    chunkCount: String(chunks.length),
    citations: jsonCell(citations),
  };
}

function buildSummary({ rows, apiBaseUrl, outDir }) {
  return {
    apiRoute: API_ROUTE,
    apiBaseUrl: apiBaseUrl || "in-process Express app",
    totalCases: rows.length,
    successCount: rows.filter((row) => row.statusCode === "200").length,
    failureCount: rows.filter((row) => row.statusCode !== "200").length,
    reportFiles: {
      csv: join(outDir, "report.csv"),
      excel: join(outDir, "report.xls"),
      json: join(outDir, "report.json"),
    },
  };
}

async function writeReports({ outDir, rows, details, apiBaseUrl }) {
  const summary = buildSummary({ rows, apiBaseUrl, outDir });

  await writeFile(join(outDir, "report.csv"), buildCsv(rows, COLUMNS), "utf8");
  await writeFile(join(outDir, "report.xls"), buildExcelXml(rows, COLUMNS), "utf8");
  await writeFile(
    join(outDir, "report.json"),
    JSON.stringify({ summary, cases: details }, null, 2),
    "utf8",
  );
  await writeFile(
    join(outDir, "summary.md"),
    [
      "# Baggage Route Evaluation",
      "",
      `- API route: \`${API_ROUTE}\``,
      `- API base: \`${summary.apiBaseUrl}\``,
      `- Total completed cases: ${summary.totalCases}`,
      `- Success: ${summary.successCount}`,
      `- Failed: ${summary.failureCount}`,
      "",
      "## Files",
      "",
      "- `report.xls`",
      "- `report.csv`",
      "- `report.json`",
      "",
      "Reports are written after every completed case, so partial results remain available if a long live run is interrupted.",
    ].join("\n"),
    "utf8",
  );

  return summary;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(
    process.cwd(),
    args.outDir || join("data", "evals", "baggage-route-latest"),
  );
  const limit = args.limit ? Number(args.limit) : CASES.length;
  const selectedCases = CASES.slice(0, Number.isFinite(limit) ? limit : CASES.length);
  const apiBaseUrl = args.apiBaseUrl || "";
  let app = null;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  if (!apiBaseUrl) {
    app = buildApp();
  }

  const rows = [];
  const details = [];

  try {
    for (const [index, testCase] of selectedCases.entries()) {
      const startedAt = Date.now();
      process.stdout.write(
        `[${index + 1}/${selectedCases.length}] ${testCase.id}... `,
      );

      try {
        const result = apiBaseUrl
          ? await callBaggageRouteWithHttp(apiBaseUrl, testCase.payload)
          : await callBaggageRouteWithApp(app, testCase.payload);
        const durationMs = Date.now() - startedAt;
        const row = buildReportRow({
          testCase,
          statusCode: result.statusCode,
          body: result.body,
          durationMs,
        });

        rows.push(row);
        details.push({
          ...testCase,
          statusCode: result.statusCode,
          durationMs,
          response: result.body,
        });
        await writeReports({ outDir, rows, details, apiBaseUrl });
        process.stdout.write(`status ${result.statusCode}\n`);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        rows.push(
          buildReportRow({
            testCase,
            statusCode: null,
            body: null,
            error,
            durationMs,
          }),
        );
        details.push({
          ...testCase,
          statusCode: null,
          durationMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await writeReports({ outDir, rows, details, apiBaseUrl });
        process.stdout.write(`error ${error.message}\n`);
      }
    }
  } finally {
    if (app) {
      await app.close();
    }
  }

  const summary = await writeReports({ outDir, rows, details, apiBaseUrl });

  console.log(JSON.stringify(summary, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
