# URL Knowledge Base Agent

This project crawls a fixed set of URLs, normalizes the crawled content into retrievable records, indexes those records in Qdrant, and answers grounded questions using mandatory HyDE retrieval plus a tool-calling OpenAI Agent.

The runtime is now modular. `src/server.js` is the only root-level runtime file;
all crawler, indexing, retrieval, agent, API, and service code lives inside
domain folders under `src/`.

## What The System Covers

The current implementation is built for two content shapes:

1. Policy-style pages
   - Privacy Policy
   - Cookie Policy
   - General Terms and Conditions

2. Baggage ecosystem data
   - the CheapOair baggage-fees directory page
   - official airline baggage pages linked from that directory

Those two shapes are indexed and retrieved differently.

## Crawl Seeds

The current seed URLs are hardcoded in `src/crawler/urls.js` as `REQUIRED_CRAWL_URLS`:

- `https://www.cheapoair.com/info/privacy#personal-information`
- `https://www.cheapoair.com/info/cookie-policy/`
- `https://www.cheapoair.com/info/generaltermsandconditions/`
- `https://www.cheapoair.com/travel/baggage-fees/`

## Crawl Strategy Per URL

### Simple crawl URLs

These are treated as normal single-page crawls:

- Privacy Policy
- Cookie Policy
- General Terms and Conditions

Flow:

1. submit the URL to Crawl4AI
2. poll until the crawl finishes
3. choose the best extracted text field from the Crawl4AI response
4. convert the response into a normalized raw document
5. pass that raw document to the indexing pipeline

### Deep crawl URL

The CheapOair baggage-fees page is treated as a discovery source, not just a single article page.

Flow:

1. crawl the root page
2. parse the root page into structured baggage rows
3. discover outbound airline policy links
4. crawl those airline links through the deep-crawl workflow
5. index the nested airline pages as official baggage-policy sources

So the baggage system has two crawl layers:

- the root CheapOair baggage directory page
- the nested airline pages linked from that page

## Existing Crawl Snapshots

If the crawler server is unavailable, the repository already contains exported crawl snapshots that can be reused in another environment.

Root crawl responses:

- `raw-responses/required-crawl-urls`

Deep baggage crawl snapshot:

- `raw-responses/baggage-deep-crawl-latest`

The deep snapshot contains:

- `run-summary.json`
- `result-index.json`
- `raw-responses/` with one raw JSON file per nested airline page

That means the system can be re-indexed from saved crawl output without re-running live crawling.

## End-To-End Pipeline

## 1. Crawling

`src/crawler/*` is responsible for:

- low-level HTTP calls
- async polling helpers
- Crawl4AI job submission and polling
- client-side deep crawl helpers
- raw Crawl4AI response normalization

For each crawled page, the crawler converts the Crawl4AI result into a normalized raw document with fields such as:

- `docId`
- `url`
- `domain`
- `title`
- `cleanedText`
- `contentHash`
- `metadata.statusCode`
- `metadata.redirectedUrl`

For deep baggage runs, the crawler layer also preserves:

- a run summary
- a URL-to-file index
- one raw JSON file per nested airline page

## 2. Indexing

`src/indexing/*` handles everything from raw text to indexed vector records.

It contains:

- config loading
- file helpers
- hashing helpers
- URL helpers
- chunking
- source typing
- content cleanup
- baggage row extraction
- vector artifact construction
- embedding helpers
- Qdrant indexing helpers
- ingestion services

There are two ingestion patterns:

1. `ingest`
   - used for the fixed URLs and the root baggage page
2. `ingest-run`
   - used to import a stored deep crawl run for nested airline pages

### 2.1 Source Type Detection

Each normalized document is classified into one of these source types:

- `privacy_policy`
- `cookie_policy`
- `terms_conditions`
- `baggage_directory`
- `baggage_directory_row`
- `airline_policy`

That classification drives how the document is cleaned, split, and indexed.

### 2.2 Policy Page Indexing

Privacy, cookie, and terms pages are treated as structured documents.

Flow:

1. remove boilerplate, menus, and repeated navigation
2. preserve headings
3. split the document with heading-aware chunking
4. keep section metadata on every chunk

Each chunk retains metadata such as:

- `sectionTitle`
- `sectionPath`
- `sectionSlug`
- `text`
- `contentHash`

This makes policy retrieval section-aware instead of treating the document as one large text blob.

### 2.3 Baggage Directory Indexing

The CheapOair baggage-fees page is not indexed only as normal text chunks.

Instead, it is parsed into row-level records, one record per airline-route row.

Each `baggage_directory_row` can contain:

- `airlineName`
- `routeScope`
- `carryOnCost`
- `carryOnWeight`
- `carryOnSize`
- `carryOnNotes`
- `firstBagUrl`
- `secondBagUrl`
- `additionalPolicyUrl`

Each row also gets:

- a readable `text`
- an `embeddingText`
- `sourceType: baggage_directory_row`

The root baggage page still also produces fallback page chunks, but row records are the primary retrieval unit for directory questions.

### 2.4 Nested Airline Page Indexing

The airline pages discovered during deep crawl are indexed as `airline_policy` documents.

Flow:

1. read the raw response from the stored deep-crawl run
2. normalize the page as `airline_policy`
3. trim lead/footer noise when possible
4. chunk by headings and paragraphs
5. embed those chunks
6. index them in Qdrant

This gives the runtime an official source layer for detailed baggage rules.

### 2.5 Embeddings And Qdrant

After records are built:

1. retrievable records are selected
2. embeddings are generated with OpenAI
3. records are upserted into Qdrant

Qdrant stores:

- vectors
- record text
- source type
- section metadata
- airline metadata
- route metadata
- baggage row fields

Local JSON artifacts are also written for inspection, but runtime retrieval is driven by Qdrant.

## What Actually Gets Indexed

### Policy pages

Indexed as semantic text chunks with heading metadata.

### CheapOair baggage page

Indexed as:

- `baggage_directory_row` records
- fallback baggage page chunks

### Nested airline pages

Indexed as:

- `airline_policy` chunks

This separation is what allows the runtime to answer:

- CheapOair directory questions from row data
- official baggage rule questions from airline pages

## 3. Retrieval

`src/retrieval/*` contains the retrieval logic.

It includes:

- query normalization
- airline matching
- baggage facet detection
- privacy aspect detection
- route-scope hint detection
- HyDE search-plan generation
- Qdrant result fusion
- baggage row routing
- linked-policy expansion
- privacy coverage repair

### 3.1 Query Understanding

Before vector search, the query is analyzed for:

- airline names
- baggage facet
- privacy aspects
- comparison intent
- route scope hints

Examples:

- `Aegean carry-on weight` -> airline + `carry_on`
- `Delta vs United 1st bag` -> comparison + airline pair + `first_checked_bag`
- `What personal information do you collect and how do you use it?` -> privacy `collect` + `use`

### 3.2 Mandatory HyDE

Free-text retrieval always uses HyDE.

The runtime:

1. sends the query to OpenAI to generate a short hypothetical source-like passage
2. embeds that hypothetical passage
3. also embeds the original query and any airline-focused variants
4. searches Qdrant with those vectors
5. fuses the result lists

For privacy queries with multiple aspects, the runtime can generate additional HyDE passages such as:

- `hyde:collect`
- `hyde:use`
- `hyde:disclose`

### 3.3 Retrieval Modes

There are three practical retrieval modes.

#### Mode A: CheapOair baggage directory query

If the question is about the CheapOair baggage-fees page, the runtime tries `baggage_directory_row` retrieval first.

Flow:

1. detect airline and baggage facet
2. pull matching rows from Qdrant
3. score rows by airline match, route scope, and field completeness
4. return the best row hit

If the query also asks for linked baggage details such as `1st bag`, the runtime can expand from the row's policy URL into the nested official airline page and retrieve detailed policy chunks there.

#### Mode B: Official airline baggage query

If the question is really about airline policy content, the runtime performs HyDE + semantic vector retrieval over `airline_policy` chunks.

#### Mode C: Policy-page query

For privacy, cookie, and terms pages, the runtime performs HyDE + semantic retrieval over heading-based chunks.

For privacy, there is also extra topic-coverage logic so multi-aspect questions do not get reduced to only one section.

## Retrieval Decision Tree

In shorthand:

- CheapOair baggage directory question -> row-first retrieval
- official airline baggage question -> semantic chunk retrieval
- privacy/cookie/terms question -> semantic chunk retrieval

## 4. Agent Answer Generation

`src/agents/index.js` is the agent CLI/export entrypoint.

It does three jobs:

1. builds the runtime services
2. exposes the API and CLI
3. uses the OpenAI Agents SDK to orchestrate retrieval and final answer generation

Important distinction:

- `/api/retrieve` still calls `RetrievalService.retrieve()` directly
- `/api/chat` now creates an agent with a `retrieve_context` function tool
- that tool calls `RetrievalService.retrieve()`
- HyDE still lives inside `src/retrieval/service.js`, but the hypothetical passage is now generated through an internal OpenAI SDK agent in `src/indexing/openai-service.js`
- the chat agent does not replace retrieval logic

The flow is:

1. user sends a chat question
2. the OpenAI Agent is created for that request
3. the agent is forced to call the `retrieve_context` tool first
4. the tool runs `RetrievalService.retrieve()`
5. retrieval executes HyDE + Qdrant search, or baggage row retrieval, depending on the query
6. when HyDE is needed, an internal SDK-based HyDE agent writes the hypothetical passage used for retrieval
7. the tool returns grounded chunks with stable citation indices
8. the agent uses that tool output to write the final cited answer

So the system is:

- retrieval-service-first
- agent-orchestrated

## Runtime Surfaces

### API

- `GET /health`
- `POST /api/ingest`
- `GET /api/ingest/jobs`
- `GET /api/ingest/jobs/:jobId`
- `POST /api/retrieve`
- `POST /api/chat`
- `POST /api/chat/baggage`
- `GET /api/docs`
- `GET /api/docs/openapi.json`

The API server starts from `src/server.js`. The Express app is built in
`src/api/app.js`, and route/handler logic is split under `src/api/`.

Swagger UI is available at `http://localhost:3000/api/docs`. The raw OpenAPI JSON is available at `http://localhost:3000/api/docs/openapi.json`.

`POST /api/ingest` is asynchronous. It accepts the same ingestion payloads as the CLI/API previously accepted, but returns immediately with a `jobId`:

```json
{
  "jobId": "ingest_...",
  "status": "queued",
  "statusUrl": "/api/ingest/jobs/ingest_..."
}
```

Monitor indexing progress with `GET /api/ingest/jobs/:jobId` or list recent jobs with `GET /api/ingest/jobs`. These jobs are stored in memory inside the Node API process, so they are suitable for local/internal runs but are not durable across server restarts.

`POST /api/chat` is the user-facing endpoint. It intentionally accepts only a natural-language `query`; callers should not send retrieval filters, `topK`, or conversation history. The chat agent infers retrieval constraints through the `retrieve_context` tool instructions.

`POST /api/chat/baggage` is a structured helper endpoint for baggage-policy questions. It accepts required `origin`, `destination`, `airline`, and `cabin`, plus optional `brandName`, builds the natural-language baggage query internally, and then sends that generated query through the same agent and `retrieve_context` tool flow used by `/api/chat`.

Example request:

```json
{
  "origin": "NYC",
  "destination": "LAX",
  "airline": "American Airlines",
  "cabin": "economy",
  "brandName": "elite"
}
```

Generated agent query:

```text
I have a flight from NYC to LAX on American Airlines in economy class with elite brand, What will be the baggage policy
```

The response includes `generatedQuery`, `normalizedInput`, `answer`, `citations`, and `chunks`.

`POST /api/retrieve` is a developer/debug endpoint for raw retrieval checks and can still accept explicit filters.

### CLI

Examples:

```bash
npm run cli -- ingest urls.example.txt --force
npm run cli -- ingest-run data/crawl4ai/runs/2026-03-05T10-08-19-582Z-baggage-fees-all-links
npm run cli -- retrieve "According to the CheapOair baggage fees page, what are Aegean Airlines carry-on and 1st bag details?" --sourceType=baggage_directory --domain=www.cheapoair.com
npm run cli -- chat "What do the CheapOair terms say about mandatory arbitration?" --sourceType=terms_conditions --domain=www.cheapoair.com
```

## Files Written During Ingestion

The runtime writes artifacts under `data/`:

- `data/crawl4ai` for original Crawl4AI payloads
- `data/raw` for normalized raw documents
- `data/chunks` for chunk and directory-row artifacts
- `data/traces` for ingestion traces

The exported reusable snapshots are at the repo root:

- `raw-responses/required-crawl-urls`
- `raw-responses/baggage-deep-crawl-latest`

## Tests

Run the test suite:

```bash
npm test
```

Run the 30-case baggage route evaluation:

```bash
npm run eval:baggage-route
```

Useful options:

```bash
npm run eval:baggage-route -- --limit=3
npm run eval:baggage-route -- --apiBaseUrl=http://localhost:3000
npm run eval:baggage-route -- --outDir=data/evals/my-baggage-run
```

The script calls `POST /api/chat/baggage` and writes:

- `data/evals/baggage-route-latest/report.xls`
- `data/evals/baggage-route-latest/report.csv`
- `data/evals/baggage-route-latest/report.json`
- `data/evals/baggage-route-latest/summary.md`

Reports are updated after every completed case, so partial results remain available if a long live agent run is interrupted.

The test suite covers:

- chunking
- Crawl4AI utility behavior
- hybrid document building
- ingestion traces
- Qdrant filters
- retrieval behavior
- API health route

## Modular Runtime Layout

- `src/server.js` = Express server entrypoint used by `npm start`
- `src/api/app.js` = Express app factory
- `src/api/routes.js` = REST route registration
- `src/api/handlers.js` = route handlers and request-level API logic
- `src/api/ingest-job-manager.js` = in-process async indexing job registry
- `src/api/request-utils.js` = shared request helpers and error handling
- `src/api/inject-compat.js` = test compatibility helper for app injection
- `src/services/kb-system.js` = dependency wiring for crawler, indexing, retrieval, and agent answering
- `src/agents/chat-agent.js` = OpenAI SDK chat agent configuration
- `src/agents/retrieve-context-tool.js` = `retrieve_context` tool, tool schema, citation registry, and tool logging
- `src/agents/kb-chat-service.js` = agent orchestration for `answerQuery()`
- `src/agents/interaction-logger.js` = chat/tool JSONL logging
- `src/indexing/*` = indexing-facing module exports and service boundaries
- `src/retrieval/*` = retrieval-facing module exports and query-routing boundaries
- `src/crawler/*` = Crawl4AI crawler client and crawl helpers

## Mental Model

Use this shortcut:

- `src/crawler/*` = get text from the web
- `src/indexing/*` = convert crawled text into indexed records
- `src/retrieval/*` = retrieve the right records
- `src/agents/*` = turn retrieved records into a grounded answer through an OpenAI SDK tool-calling agent
- `src/api/*` = expose the workflow as REST endpoints
