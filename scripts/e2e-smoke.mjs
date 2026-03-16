import http from "node:http";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");
const appPort = 3001;
const mockPort = 4010;
const shouldUseMockOpenAI =
  process.env.USE_MOCK_OPENAI === "1" || !process.env.OPENAI_API_KEY;
const smokeCollection = shouldUseMockOpenAI
  ? "url_kb_smoke_mock"
  : "url_kb_smoke_real";

function embeddingFor(text) {
  const dims = 12;
  const vector = Array.from({ length: dims }, () => 0);
  const input = String(text || "");

  for (let index = 0; index < input.length; index += 1) {
    vector[index % dims] += input.charCodeAt(index) / 255;
  }

  const norm =
    Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;

  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function createMockOpenAIServer() {
  return http.createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
    });

    request.on("end", () => {
      const payload = body ? JSON.parse(body) : {};

      if (request.method === "POST" && request.url === "/v1/embeddings") {
        const inputs = Array.isArray(payload.input)
          ? payload.input
          : [payload.input];
        const data = inputs.map((input, index) => ({
          object: "embedding",
          index,
          embedding: embeddingFor(input),
        }));

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data,
            model: payload.model || "mock-embedding",
          }),
        );
        return;
      }

      if (
        request.method === "POST" &&
        request.url === "/v1/chat/completions"
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "mock-chat",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    "Mock grounded answer. Retrieved context was provided to the model. [1]",
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found", path: request.url }));
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
  }

  return data;
}

function runCli(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["src/agents.js", ...args], {
      cwd: rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", rejectRun);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectRun(
          new Error(`CLI command failed with code ${code}: ${stderr || stdout}`),
        );
        return;
      }

      resolveRun(JSON.parse(stdout));
    });
  });
}

process.env.PORT = String(appPort);
process.env.CRAWL4AI_TIMEOUT_MS = "300000";
process.env.CRAWL4AI_POLL_INTERVAL_MS = "2000";
process.env.QDRANT_COLLECTION = smokeCollection;

let mockServer = null;

if (shouldUseMockOpenAI) {
  process.env.OPENAI_API_KEY = "mock-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;

  mockServer = createMockOpenAIServer();
  await new Promise((resolveListen) => {
    mockServer.listen(mockPort, "127.0.0.1", resolveListen);
  });
}

const { buildApp } = await import("../src/agents.js");
const app = buildApp();

try {
  await app.listen({ port: appPort, host: "127.0.0.1" });

  const baseUrl = `http://127.0.0.1:${appPort}`;
  const query = "What personal information does CheapOair collect?";
  const url = "https://www.cheapoair.com/info/privacy#personal-information";
  const filter = { domain: "www.cheapoair.com" };
  const env = { ...process.env };

  const health = await requestJson(`${baseUrl}/health`);
  const ingest = await requestJson(`${baseUrl}/api/ingest`, {
    method: "POST",
    body: JSON.stringify({
      urls: [url],
      force: true,
    }),
  });
  const retrieve = await requestJson(`${baseUrl}/api/retrieve`, {
    method: "POST",
    body: JSON.stringify({
      query,
      topK: 4,
      filter,
    }),
  });
  const chat = await requestJson(`${baseUrl}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      query,
      topK: 4,
      filter,
    }),
  });

  const cliRetrieve = await runCli(
    ["retrieve", query, "--topK=3", "--domain=www.cheapoair.com"],
    env,
  );
  const cliChat = await runCli(
    ["chat", query, "--topK=3", "--domain=www.cheapoair.com"],
    env,
  );

  const summary = {
    openAiMode: shouldUseMockOpenAI ? "mock" : "real",
    health,
    ingestSummary: {
      total: ingest.total,
      ingested: ingest.ingested,
      skipped: ingest.skipped,
      failed: ingest.failed,
      firstResult: ingest.results[0],
    },
    retrieveSummary: {
      resultCount: retrieve.results.length,
      firstUrl: retrieve.results[0]?.url || null,
      firstTitle: retrieve.results[0]?.title || null,
      firstSectionPath: retrieve.results[0]?.sectionPath?.join(" > ") || null,
      firstChunkLength: retrieve.results[0]?.text?.length || 0,
    },
    chatSummary: {
      answer: chat.answer,
      citationCount: chat.citations.length,
      firstCitationUrl: chat.citations[0]?.url || null,
    },
    cliRetrieveSummary: {
      resultCount: cliRetrieve.results.length,
      firstUrl: cliRetrieve.results[0]?.url || null,
    },
    cliChatSummary: {
      answer: cliChat.answer,
      citationCount: cliChat.citations.length,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await app.close();
  if (mockServer) {
    await closeServer(mockServer);
  }
}
