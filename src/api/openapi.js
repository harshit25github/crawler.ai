export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "URL Knowledge Base Agent API",
    version: "0.1.0",
    description:
      "REST API for asynchronous indexing jobs, raw retrieval, and tool-calling knowledge-base chat.",
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Local development server",
    },
  ],
  tags: [
    {
      name: "Health",
      description: "Service health checks.",
    },
    {
      name: "Indexing",
      description: "Asynchronous crawl, chunk, embed, and Qdrant indexing jobs.",
    },
    {
      name: "Retrieval",
      description: "Developer-facing raw retrieval endpoint.",
    },
    {
      name: "Chat",
      description: "Agent-backed user answer endpoints.",
    },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Check API health",
        responses: {
          200: {
            description: "Service is running.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/HealthResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/ingest": {
      post: {
        tags: ["Indexing"],
        summary: "Create an asynchronous indexing job",
        description:
          "Creates an in-process background job. The API returns immediately with a jobId; monitor status via /api/ingest/jobs/{jobId}.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/IngestUrlsRequest" },
                  { $ref: "#/components/schemas/IngestUrlsFileRequest" },
                  { $ref: "#/components/schemas/IngestRunDirRequest" },
                ],
              },
              examples: {
                urls: {
                  summary: "Index explicit URLs",
                  value: {
                    urls: [
                      "https://www.cheapoair.com/info/privacy#personal-information",
                    ],
                    force: false,
                  },
                },
                urlsFile: {
                  summary: "Index URLs from a repo-local file",
                  value: {
                    urlsFile: "urls.required.txt",
                    force: false,
                  },
                },
                runDir: {
                  summary: "Import a stored deep-crawl run",
                  value: {
                    runDir:
                      "data/crawl4ai/runs/2026-03-05T10-08-19-582Z-baggage-fees-all-links",
                  },
                },
              },
            },
          },
        },
        responses: {
          202: {
            description: "Indexing job accepted.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/IngestJobCreatedResponse",
                },
              },
            },
          },
          400: {
            description: "Invalid ingestion payload.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/ingest/jobs": {
      get: {
        tags: ["Indexing"],
        summary: "List in-memory indexing jobs",
        responses: {
          200: {
            description: "Recent ingestion jobs.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["jobs"],
                  properties: {
                    jobs: {
                      type: "array",
                      items: {
                        $ref: "#/components/schemas/IngestJob",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/ingest/jobs/{jobId}": {
      get: {
        tags: ["Indexing"],
        summary: "Get indexing job status",
        parameters: [
          {
            name: "jobId",
            in: "path",
            required: true,
            schema: {
              type: "string",
              example: "ingest_mo0phish_f21c43d3",
            },
          },
        ],
        responses: {
          200: {
            description: "Indexing job status.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/IngestJob",
                },
              },
            },
          },
          404: {
            description: "Job was not found in the in-memory registry.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/retrieve": {
      post: {
        tags: ["Retrieval"],
        summary: "Run raw retrieval",
        description:
          "Developer/debug endpoint that calls RetrievalService directly. User-facing chat should use /api/chat or /api/chat/baggage.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/RetrieveRequest",
              },
              example: {
                query: "What is Delta carry-on baggage policy?",
                topK: 6,
                filter: {
                  sourceType: "airline_policy",
                  airline: "Delta Air Lines",
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Retrieved chunks.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RetrieveResponse",
                },
              },
            },
          },
          400: {
            description: "Missing query.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/chat": {
      post: {
        tags: ["Chat"],
        summary: "Answer a natural-language KB question",
        description:
          "Creates a tool-calling OpenAI Agent that must call retrieve_context before answering. The public chat endpoint accepts only natural language.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ChatRequest",
              },
              example: {
                query:
                  "What do the CheapOair terms say about mandatory arbitration?",
              },
            },
          },
        },
        responses: {
          200: {
            description: "Grounded agent answer.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ChatResponse",
                },
              },
            },
          },
          400: {
            description: "Missing query.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
    "/api/chat/baggage": {
      post: {
        tags: ["Chat"],
        summary: "Answer a structured baggage-policy question",
        description:
          "Builds a natural-language baggage-policy query from route, airline, cabin, and optional fare brand, then sends it through the same agent flow as /api/chat.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/BaggageChatRequest",
              },
              example: {
                origin: "NYC",
                destination: "LAX",
                airline: "American Airlines",
                cabin: "economy",
                brandName: "elite",
              },
            },
          },
        },
        responses: {
          200: {
            description: "Grounded baggage-policy answer.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/BaggageChatResponse",
                },
              },
            },
          },
          400: {
            description: "Invalid baggage payload.",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ErrorResponse",
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "string",
          },
          errors: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
      },
      HealthResponse: {
        type: "object",
        required: ["status", "collection"],
        properties: {
          status: {
            type: "string",
            example: "ok",
          },
          collection: {
            type: "string",
            example: "url_kb",
          },
        },
      },
      IngestUrlsRequest: {
        type: "object",
        required: ["urls"],
        properties: {
          urls: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              format: "uri",
            },
          },
          force: {
            type: "boolean",
            default: false,
          },
        },
      },
      IngestUrlsFileRequest: {
        type: "object",
        required: ["urlsFile"],
        properties: {
          urlsFile: {
            type: "string",
            example: "urls.required.txt",
          },
          force: {
            type: "boolean",
            default: false,
          },
        },
      },
      IngestRunDirRequest: {
        type: "object",
        required: ["runDir"],
        properties: {
          runDir: {
            type: "string",
          },
        },
      },
      IngestJobCreatedResponse: {
        type: "object",
        required: ["jobId", "status", "statusUrl"],
        properties: {
          jobId: {
            type: "string",
          },
          status: {
            type: "string",
            enum: ["queued"],
          },
          statusUrl: {
            type: "string",
          },
        },
      },
      IngestJob: {
        type: "object",
        required: [
          "jobId",
          "type",
          "status",
          "createdAt",
          "startedAt",
          "finishedAt",
          "progress",
          "result",
          "error",
        ],
        properties: {
          jobId: {
            type: "string",
          },
          type: {
            type: "string",
            enum: ["urls", "runDir"],
          },
          status: {
            type: "string",
            enum: ["queued", "running", "succeeded", "failed"],
          },
          createdAt: {
            type: "string",
            format: "date-time",
          },
          startedAt: {
            type: ["string", "null"],
            format: "date-time",
          },
          finishedAt: {
            type: ["string", "null"],
            format: "date-time",
          },
          progress: {
            $ref: "#/components/schemas/IngestProgress",
          },
          result: {
            type: ["object", "null"],
            additionalProperties: true,
          },
          error: {
            type: ["object", "null"],
            additionalProperties: true,
          },
        },
      },
      IngestProgress: {
        type: "object",
        required: [
          "stage",
          "total",
          "completed",
          "ingested",
          "skipped",
          "failed",
          "currentUrl",
        ],
        properties: {
          stage: {
            type: "string",
          },
          total: {
            type: "integer",
          },
          completed: {
            type: "integer",
          },
          ingested: {
            type: "integer",
          },
          skipped: {
            type: "integer",
          },
          failed: {
            type: "integer",
          },
          currentUrl: {
            type: ["string", "null"],
          },
        },
      },
      RetrieveRequest: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
          },
          topK: {
            type: "integer",
            minimum: 1,
          },
          filter: {
            $ref: "#/components/schemas/RetrievalFilter",
          },
        },
      },
      RetrievalFilter: {
        type: "object",
        properties: {
          domain: {
            type: "string",
          },
          url: {
            type: "string",
          },
          sourceType: {
            type: "string",
            enum: [
              "privacy_policy",
              "cookie_policy",
              "terms_conditions",
              "service_fees",
              "post_ticketing_fees",
              "baggage_directory",
              "baggage_directory_row",
              "airline_policy",
            ],
          },
          airline: {
            type: "string",
          },
          facet: {
            type: "string",
            enum: [
              "carry_on",
              "first_checked_bag",
              "second_checked_bag",
              "oversize",
              "overweight",
              "special_items",
              "additional_policy",
            ],
          },
        },
      },
      RetrieveResponse: {
        type: "object",
        required: ["query", "results"],
        properties: {
          query: {
            type: "string",
          },
          results: {
            type: "array",
            items: {
              $ref: "#/components/schemas/Chunk",
            },
          },
        },
      },
      ChatRequest: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
          },
        },
      },
      ChatResponse: {
        type: "object",
        required: ["answer", "citations", "chunks"],
        properties: {
          answer: {
            type: "string",
          },
          citations: {
            type: "array",
            items: {
              $ref: "#/components/schemas/Citation",
            },
          },
          chunks: {
            type: "array",
            items: {
              $ref: "#/components/schemas/Chunk",
            },
          },
        },
      },
      BaggageChatRequest: {
        type: "object",
        required: ["origin", "destination", "airline", "cabin"],
        properties: {
          origin: {
            type: "string",
            example: "NYC",
          },
          destination: {
            type: "string",
            example: "LAX",
          },
          airline: {
            type: "string",
            example: "American Airlines",
          },
          cabin: {
            type: "string",
            example: "economy",
          },
          brandName: {
            type: "string",
            example: "elite",
          },
        },
      },
      BaggageChatResponse: {
        allOf: [
          {
            type: "object",
            required: ["generatedQuery", "normalizedInput"],
            properties: {
              generatedQuery: {
                type: "string",
              },
              normalizedInput: {
                type: "object",
                properties: {
                  origin: { type: "string" },
                  destination: { type: "string" },
                  airline: { type: "string" },
                  cabin: { type: "string" },
                  brandName: { type: ["string", "null"] },
                },
              },
            },
          },
          {
            $ref: "#/components/schemas/ChatResponse",
          },
        ],
      },
      Citation: {
        type: "object",
        properties: {
          citationIndex: {
            type: "integer",
          },
          url: {
            type: "string",
          },
          title: {
            type: "string",
          },
          sectionPath: {
            type: "array",
            items: {
              type: ["string", "null"],
            },
          },
          chunkIndex: {
            type: "integer",
          },
          score: {
            type: "number",
          },
        },
      },
      Chunk: {
        type: "object",
        additionalProperties: true,
        properties: {
          citationIndex: {
            type: "integer",
          },
          id: {
            type: "string",
          },
          score: {
            type: "number",
          },
          url: {
            type: "string",
          },
          title: {
            type: "string",
          },
          sourceType: {
            type: "string",
          },
          airlineName: {
            type: ["string", "null"],
          },
          routeScope: {
            type: ["string", "null"],
          },
          sectionTitle: {
            type: ["string", "null"],
          },
          sectionPath: {
            type: "array",
            items: {
              type: ["string", "null"],
            },
          },
          text: {
            type: "string",
          },
        },
      },
    },
  },
};

export function renderSwaggerHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>URL Knowledge Base Agent API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #f7f7f7; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/api/docs/openapi.json",
        dom_id: "#swagger-ui",
        presets: [SwaggerUIBundle.presets.apis],
        layout: "BaseLayout"
      });
    </script>
  </body>
</html>`;
}
