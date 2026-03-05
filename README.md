# URL Knowledge Base Agent

Node.js service for:

- crawling URLs with Crawl4AI
- chunking extracted markdown/text
- embedding chunks with OpenAI
- storing vectors in Qdrant
- answering user questions with retrieved chunks and citations

## Architecture

1. Ingestion
   - Crawl4AI fetches a URL
   - the original Crawl4AI payload is stored in `data/crawl4ai`
   - raw markdown/text is stored in `data/raw`
   - text is chunked into retrieval-friendly sections
   - chunks are embedded with OpenAI
   - vectors and payloads are upserted into Qdrant

2. Runtime
   - a user query is embedded
   - Qdrant returns top matching chunks
   - the agent answers using only those chunks
   - responses include citation markers and source metadata

## Project Layout

- `src/services/crawl4ai-client.js`: Crawl4AI async job client
- `src/services/crawl4ai-utility.js`: reusable Crawl4AI service wrapper (`/crawl`, `/crawl/job`, `/llm/job`, `/md`, `/html`, `/execute_js`, monitoring)
- `src/lib/chunker.js`: heading-aware markdown chunker
- `src/services/openai-service.js`: embeddings and grounded answer generation
- `src/services/qdrant-service.js`: collection management, delete, upsert, search
- `src/services/ingestion-service.js`: end-to-end ingestion pipeline
- `src/services/retrieval-service.js`: query embedding + Qdrant lookup
- `src/agent/tools/retrieve-chunks-tool.js`: retrieval tool exposed to the agent layer
- `src/services/agent-service.js`: retrieval-grounded answer orchestration
- `src/app.js`: Fastify routes
- `src/cli.js`: local CLI

## Setup

1. Install dependencies:

```bash
npm install
```

2. Start dependencies:

```bash
docker compose up -d
```

3. Copy env file and fill in your OpenAI key:

```bash
copy .env.example .env
```

4. Start the API:

```bash
npm run dev
```

## CLI

Ingest a file of URLs:

```bash
npm run cli -- ingest urls.example.txt
```

Ingest a single URL:

```bash
npm run cli -- ingest https://www.cheapoair.com/info/privacy#personal-information
```

Retrieve chunks:

```bash
npm run cli -- retrieve "What personal information does CheapOair collect?"
```

Ask the agent:

```bash
npm run cli -- chat "What personal information does CheapOair collect?"
```

## API

- `GET /health`
- `POST /api/ingest`
- `POST /api/retrieve`
- `POST /api/chat`

### `POST /api/ingest`

```json
{
  "urls": [
    "https://www.cheapoair.com/info/privacy#personal-information"
  ],
  "force": false
}
```

You can also pass:

```json
{
  "urlsFile": "urls.example.txt"
}
```

### `POST /api/retrieve`

```json
{
  "query": "What personal information does CheapOair collect?",
  "topK": 6,
  "filter": {
    "domain": "www.cheapoair.com"
  }
}
```

### `POST /api/chat`

```json
{
  "query": "What personal information does CheapOair collect?",
  "topK": 6,
  "filter": {
    "domain": "www.cheapoair.com"
  }
}
```

## Notes

- The original crawler response is saved in `data/crawl4ai` so you can inspect what Crawl4AI returned before normalization.
- Qdrant vector size is created dynamically from the first embedding response.
- Each payload stores `url`, `domain`, `title`, `chunkIndex`, `sectionPath`, `text`, `fetchedAt`, `contentHash`, and `docId`.
- Unchanged documents are skipped unless `force` is set.
- Each ingestion run also writes a step-by-step trace file to `data/traces`.
- Detailed pipeline notes and Crawl4AI fetch behavior are documented in `docs/ingestion-tracing.md`.
