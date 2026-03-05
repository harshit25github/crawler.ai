# Ingestion Tracing

This project now writes a detailed per-URL trace file for each ingestion run.

## Where to look

- Original Crawl4AI response: `data/crawl4ai/<url-stem>.json`
- Raw extracted document: `data/raw/<url-stem>.json`
- Chunked document: `data/chunks/<url-stem>.json`
- Step-by-step trace: `data/traces/<url-stem>.trace.json`

The trace file is the best place to understand what happened during indexing.

For the current CheapOair example, you can open:

- [Trace file](../data/traces/www-cheapoair-com-info-privacy-c0f80af8e93e.trace.json)
- [Original Crawl4AI response](../data/crawl4ai/www-cheapoair-com-info-privacy-c0f80af8e93e.json)
- [Raw extracted document](../data/raw/www-cheapoair-com-info-privacy-c0f80af8e93e.json)
- [Chunked document](../data/chunks/www-cheapoair-com-info-privacy-c0f80af8e93e.json)

## What the trace contains

Each trace file includes:

- `requirements`: the services and config that must exist for ingestion to work
- `pipeline`: key runtime settings used for the run
- `steps`: chronological events from fetch to Qdrant upsert
- `summary`: final output information such as chunk count, vector dimension, and written file paths
- `status`: `running`, `completed`, `skipped`, or `failed`

## Crawl4AI fetch flow

The URL fetch stage uses Crawl4AI as an async job system:

1. `POST /crawl/job`
   - The app submits `{ "urls": ["<target-url>"] }`
   - Crawl4AI returns a `task_id`

2. `GET /crawl/job/{task_id}`
   - The app polls until status becomes `completed`
   - Intermediate statuses are written into the trace as polling steps

3. Extraction
   - On completion, the code prefers these content fields in order:
     - `markdown.fit_markdown`
     - `markdown.raw_markdown`
     - `markdown`
     - `cleaned_text`
     - `text`
     - `content`
     - `extracted_content`
   - The chosen field is recorded in the trace as `extractedFrom`

4. Normalization
   - The extracted text is trimmed
   - A title is selected from metadata or derived from the first heading
   - A content hash is computed so unchanged pages can be skipped on later runs

## Requirements

These are the important runtime dependencies:

- Crawl4AI server reachable at `CRAWL4AI_BASE_URL`
- Qdrant reachable at `QDRANT_URL`
- OpenAI API key in `OPENAI_API_KEY`
- OpenAI embedding model configured in `OPENAI_EMBEDDING_MODEL`

The trace file records whether these were configured for the run without exposing the actual API key value.

## Important stages after fetching

### Raw document save

The fetched page is stored in `data/raw` before chunking. This is the canonical extracted source used for later debugging.

### Original Crawl4AI response save

The unnormalized Crawl4AI payload is stored in `data/crawl4ai`. This lets you inspect:

- the async job submit response
- the completed job response returned by Crawl4AI
- the exact selected result payload
- which content field was chosen by the app

### Change detection

If the new `contentHash` matches the previous raw document and `force` is not enabled, the run is marked as `skipped`.

### Chunking

Chunking is heading-aware:

- prefer markdown headings like `##` and `###`
- otherwise split by paragraphs
- keep chunks near the configured target length
- optionally carry overlap text between chunks

The trace records chunk count, length stats, and sampled section paths.

### Embeddings

Each chunk is embedded with OpenAI using the configured embedding model. The trace records:

- model name
- embedding input count
- vector dimension

### Qdrant indexing

The pipeline then:

1. creates or validates the target collection
2. deletes older points for the same `docId`
3. upserts the new chunk vectors

The trace records collection name, whether it was created, and how many points were written.

## How to read failures

If ingestion fails, open the trace file and look at the last step.

Typical failure points:

- Crawl4AI unavailable or returning non-completed job states
- empty extracted text
- missing `OPENAI_API_KEY`
- embedding/vector dimension mismatch with an existing Qdrant collection
- Qdrant connection or upsert failure

## Example workflow

Run:

```bash
npm run cli -- ingest https://www.cheapoair.com/info/privacy#personal-information
```

Then inspect:

- [Trace file](../data/traces/www-cheapoair-com-info-privacy-c0f80af8e93e.trace.json)
- [Original Crawl4AI response](../data/crawl4ai/www-cheapoair-com-info-privacy-c0f80af8e93e.json)
- [Raw extracted document](../data/raw/www-cheapoair-com-info-privacy-c0f80af8e93e.json)
- [Chunked document](../data/chunks/www-cheapoair-com-info-privacy-c0f80af8e93e.json)

If your editor does not open markdown file links directly, use quick open and paste one of these paths:

- `data/crawl4ai/www-cheapoair-com-info-privacy-c0f80af8e93e.json`
- `data/traces/www-cheapoair-com-info-privacy-c0f80af8e93e.trace.json`
- `data/raw/www-cheapoair-com-info-privacy-c0f80af8e93e.json`
- `data/chunks/www-cheapoair-com-info-privacy-c0f80af8e93e.json`

That file will show the exact pipeline progression from:

- ingestion started
- Crawl4AI job submitted
- Crawl4AI job polled
- raw text extracted
- raw file saved
- chunks created
- embeddings created
- Qdrant collection checked
- points deleted
- points upserted
- ingestion completed
