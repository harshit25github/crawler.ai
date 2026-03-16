# Vectorless-First Hybrid Retrieval for CheapOair Sources

## Summary
- Do not use the current legacy vector-only pipeline as the main retrieval path for both URLs.
- Use a vectorless-first hybrid: deterministic source routing plus lexical/structural retrieval as primary, with embeddings only as rerank/fallback inside a small candidate set.
- Reason: the privacy page is one structured policy document. The current crawl produced about 37.7k chars and 22 chunks, but the first chunks are boilerplate and TOC, so naive semantic retrieval will waste precision.
- Reason: the baggage page is a discovery hub, not the truth source. The current deep crawl reached 420 URLs across about 261 domains; 76 successful pages are thin/unusable and several are blocked or 4xx, so global vector search will be noisy.
- If one label is required, call this `hybrid RAG`. For the privacy page, vectorless alone is enough. For baggage, use vectorless primary with vector fallback.

## Key Changes
- Add a normalized document model with `source_type`, `authority`, `quality_status`, `canonical_url`, `redirected_url`, `parent_source_url`, `airline_name`, `airline_id`, `section_title`, `section_path`, `section_slug`, `anchor_text`, and `content_hash`.
- Create a `sections` store in SQLite FTS5 as the primary retrieval index for cleaned section text, headings, and metadata filters.
- Create an `airline_registry` store that maps airline name to the CheapOair baggage row and the outbound airline policy URLs discovered from that row.
- Keep Qdrant only for `airline_policy` section vectors, and only use it after routing and lexical narrowing.
- Add a `baggage_facts` store for comparison queries with `facet`, `value_text`, `conditions`, `units`, `effective_date`, and `source_section_id`.

## Retrieval Design
- Privacy page: simple crawl only.
- Privacy cleanup: drop pre-H1 boilerplate, drop TOC/link lists, fix heading-path gaps, split by H1/H3 sections, then split long sections by paragraphs.
- Privacy retrieval: hard-filter to this document, search headings and section text lexically first, then optionally vector-rerank only the top few sections.
- Baggage page: treat the CheapOair page as `discovery_only`, not as the authority for baggage rules except for airline discovery and outbound links.
- Baggage normalization: parse the directory rows into `airline_registry` records with airline name, row text, policy URLs, and crawl status.
- Baggage crawl: deep crawl linked airline pages and mark pages `unusable` when bot-blocked, redirect-only, 4xx/5xx, or thin after cleanup.
- Baggage retrieval step 1: detect airline names and baggage facets from the query.
- Baggage retrieval step 2: route to candidate airline docs through `airline_registry` before any semantic search.
- Baggage retrieval step 3: run lexical and heading-based retrieval over only that airline’s cleaned sections.
- Baggage retrieval step 4: use Qdrant rerank only within that bounded candidate set.
- Baggage retrieval step 5: for multi-airline comparisons, answer from `baggage_facts` first and attach the backing section citations.
- Cleanup rules: remove nav/cookie/language selector blocks, `Skip to content`, link-heavy menus, and repeated site chrome; dedupe by `canonical_url + content_hash`; keep unusable pages in crawl logs but exclude them from searchable indexes.

## Public Interfaces
- Ingestion output should expose `source_type`, `authority`, `quality_status`, `canonical_url`, `redirected_url`, `airline_name`, `section_slug`, and `retrieval_allowed`.
- Retrieval API should accept optional `sourceType`, `airline`, and `facet` filters so obvious queries bypass global search.
- Comparison responses should return both normalized fact rows and the source section citations that support them.

## Test Plan
- Privacy query: “What personal information does CheapOair collect?” must hit `PERSONAL INFORMATION`, not boilerplate or TOC.
- Privacy query: “How do I opt out of marketing emails?” must resolve from headings and local section text without broad semantic search.
- Baggage query: “What is Delta carry-on baggage policy?” must route to Delta sources before vector search.
- Comparison query: “Compare Delta and United carry-on baggage” must prefer `baggage_facts` and cite both airlines’ source sections.
- Negative case: if a target airline page is blocked or unusable, the answer must say the source could not be verified from the crawl and must not infer from similar airlines.
- Refresh case: unchanged pages are skipped via `content_hash`; changed pages replace prior sections and facts cleanly.

## Assumptions
- The local crawl artifacts from March 5, 2026 are representative enough to design the indexing strategy.
- The first release needs both grounded Q&A and airline comparison support.
- The highest-quality outcome for this corpus comes from vectorless-first routing and fielded retrieval, with embeddings used only as a bounded fallback rather than the primary search method.
