# URL Knowledge Base Agent

This project crawls a small set of web sources, converts them into retrievable records, indexes them in Qdrant, and answers grounded questions using mandatory HyDE retrieval plus an OpenAI Agent for final answer synthesis.

The current codebase is intentionally flattened. The entire runtime now lives in only four source files:

- `src/crawler.js`
- `src/indexing.js`
- `src/retrivel.js`
- `src/agents.js`

## What The System Does

The system is built for two main content shapes:

1. Structured policy pages
   - Privacy Policy
   - Cookie Policy
   - General Terms and Conditions

2. Structured baggage directory data
   - CheapOair baggage-fees directory page
   - Official airline baggage pages linked from that directory

These source types are treated differently during indexing and retrieval.

## Hardcoded Crawl Seeds

The required seed URLs are hardcoded in `src/crawler.js` as `REQUIRED_CRAWL_URLS`:

- `https://www.cheapoair.com/info/privacy#personal-information`
- `https://www.cheapoair.com/info/cookie-policy/`
- `https://www.cheapoair.com/info/generaltermsandconditions/`
- `https://www.cheapoair.com/travel/baggage-fees/`

## End-To-End Flow

### 1. Crawling

`src/crawler.js` is responsible for Crawl4AI interaction.

It contains:

- low-level HTTP helpers
- async polling helpers
- Crawl4AI job submission and polling logic
- client-side deep crawl utility support
- raw Crawl4AI result normalization

For a normal page crawl:

1. submit the URL to Crawl4AI
2. poll until the job completes
3. pick the best extracted text from the Crawl4AI response
4. convert the result into a normalized raw document

The normalized raw document contains fields such as:

- `docId`
- `url`
- `domain`
- `title`
- `cleanedText`
- `contentHash`
- `metadata.statusCode`
- `metadata.redirectedUrl`

### 2. Normalization And Indexing

`src/indexing.js` handles everything from raw text to vector-ready records.

It contains:

- environment config
- file helpers
- hashing and URL helpers
- heading-aware chunking
- source-type detection
- document cleanup
- baggage row extraction
- vector artifact construction
- OpenAI embedding helpers
- Qdrant indexing helpers
- ingestion services

### 2.1 Source Type Detection

Each crawled page is classified into one of these source types:

- `privacy_policy`
- `cookie_policy`
- `terms_conditions`
- `baggage_directory`
- `baggage_directory_row`
- `airline_policy`

This matters because the system does not index every page shape the same way.

### 2.2 Policy Page Processing

For privacy, cookie, and terms pages:

1. boilerplate and navigation noise are removed
2. markdown headings are preserved
3. the document is split with heading-aware chunking
4. each chunk keeps section metadata such as:
   - `sectionTitle`
   - `sectionPath`
   - `sectionSlug`
   - `text`

This means policy retrieval is done over semantic chunks that still know which section they came from.

### 2.3 Baggage Directory Processing

The CheapOair baggage-fees page is not treated like a normal article.

Instead of only chunking the whole page, the system parses it into structured airline rows.

For each row, it extracts values such as:

- `airlineName`
- `routeScope`
- `carryOnCost`
- `carryOnWeight`
- `carryOnSize`
- `carryOnNotes`
- `firstBagUrl`
- `secondBagUrl`
- `additionalPolicyUrl`

Each extracted row becomes a first-class record with:

- `sourceType: baggage_directory_row`
- readable `text`
- retrieval-oriented `embeddingText`

The root baggage page also still produces fallback chunks, but row records are the primary retrieval unit for directory queries.

### 2.4 Embeddings And Qdrant

After records are built:

1. retrievable records are selected
2. embeddings are created with OpenAI
3. records are upserted into Qdrant with payload metadata

Qdrant stores:

- the vector
- the record text
- source type
- section metadata
- airline metadata
- route metadata
- baggage row fields

Local JSON files are also written under `data/` for inspection and debugging, but runtime retrieval is driven by Qdrant.

## Retrieval Flow

`src/retrivel.js` contains the retrieval logic.

It includes:

- query normalization
- airline matching
- baggage facet detection
- privacy aspect detection
- route-scope hint detection
- HyDE search-plan generation
- Qdrant search fusion
- baggage row routing
- linked policy expansion
- privacy topic coverage repair

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

The system:

1. sends the query to OpenAI to generate a short hypothetical source-like passage
2. embeds that passage
3. also embeds the original query and any airline-focused variants
4. searches Qdrant using those vectors
5. fuses the result lists

For privacy queries with multiple aspects, the system can generate aspect-specific HyDE passages such as:

- `hyde:collect`
- `hyde:use`
- `hyde:disclose`

### 3.3 Baggage Retrieval

Baggage retrieval has two different modes.

#### CheapOair baggage directory queries

If the query is about the CheapOair baggage-fees page, the system tries `baggage_directory_row` mode first.

That means:

1. detect airline and facet
2. pull matching row records from Qdrant
3. score rows by airline match, route scope, and field completeness
4. return the best row hit

If the query asks for `1st bag`, `2nd bag`, or `additional policy`, the system can expand from the row’s policy URL into the linked official airline page and retrieve detailed policy chunks from there.

#### Official airline baggage page queries

If the query is about airline policy content rather than the CheapOair directory row itself, the system performs HyDE + semantic vector retrieval over `airline_policy` chunks.

### 3.4 Privacy / Terms / Cookie Retrieval

For structured policy pages:

1. heading-based chunks are searched semantically
2. HyDE improves recall
3. privacy coverage logic makes sure multi-topic questions are not answered from only one section when two sections are needed

## Agent Flow

`src/agents.js` is the top-level runtime and API/CLI entrypoint.

It does three jobs:

1. builds the runtime services
2. exposes the Fastify API and CLI
3. uses the OpenAI Agents SDK for final grounded answer generation

The OpenAI Agent is **not** used to perform retrieval.

Instead:

1. `retrivel.js` retrieves the relevant rows/chunks
2. `agents.js` formats that retrieved context
3. the OpenAI Agent writes the final answer using only that context

So the system is:

- retrieval-first
- agent-second

## Runtime Surfaces

### API

- `GET /health`
- `POST /api/ingest`
- `POST /api/retrieve`
- `POST /api/chat`

### CLI

Examples:

```bash
npm run cli -- ingest urls.example.txt --force
npm run cli -- ingest-run data/crawl4ai/runs/2026-03-05T10-08-19-582Z-baggage-fees-all-links
npm run cli -- retrieve "According to the CheapOair baggage fees page, what are Aegean Airlines carry-on and 1st bag details?" --sourceType=baggage_directory --domain=www.cheapoair.com
npm run cli -- chat "What do the CheapOair terms say about mandatory arbitration?" --sourceType=terms_conditions --domain=www.cheapoair.com
```

## Data Written During Ingestion

The runtime writes artifacts under `data/`:

- `data/crawl4ai`: original Crawl4AI payloads
- `data/raw`: normalized raw documents
- `data/chunks`: chunk and directory-row artifacts
- `data/traces`: ingestion traces

These artifacts are useful for debugging and inspection. Qdrant remains the live retrieval store.

## Tests

Run the test suite:

```bash
npm test
```

The suite covers:

- chunking
- Crawl4AI utilities
- hybrid document building
- ingestion traces
- Qdrant filters
- retrieval behavior
- API health route

## Current Mental Model

Use this shortcut:

- `src/crawler.js` = get text from the web
- `src/indexing.js` = convert text into indexed records
- `src/retrivel.js` = find the right records
- `src/agents.js` = turn retrieved records into a grounded answer
