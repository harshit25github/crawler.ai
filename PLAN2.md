# Accuracy Lift Plan for Mandatory-HyDE Retrieval

## Summary
- Keep **HyDE mandatory** for all free-text retrieval.
- Fix the biggest accuracy gap by adding a **structured row retrieval path** for the CheapOair root baggage directory, while keeping privacy and official airline-policy pages on the current HyDE + Qdrant flow.
- Target the current benchmark failures directly: `directory_single`, `directory_compare`, and the one remaining privacy multi-aspect miss.

## Key Changes
- Replace the current loose baggage-directory row extraction with a **deterministic parser** that treats each airline table row as a first-class record.
  - Row boundary: start at the airline/image line, then capture fixed column blocks for `Destinations`, `CarryOn`, `1st Bag`, `2nd Bag`, and `Additional Policy`.
  - Normalize duplicates from repeated carry-on markup and collapse repeated `View policy` links.
  - Emit one record per airline-route row, not one giant page chunk.
- Add a new internal record type: `baggage_directory_row`.
  - Required fields: `rowId`, `docId`, `sourceUrl`, `airlineName`, `airlineSlug`, `routeScope`, `carryOnText`, `carryOnCost`, `carryOnWeight`, `carryOnSize`, `carryOnNotes`, `firstBagUrl`, `secondBagUrl`, `additionalPolicyUrl`, `rowText`, `embeddingText`, `retrievalAllowed`.
  - Keep the same `docId` as the root baggage page so refresh/delete stays simple.
- Index each `baggage_directory_row` as an independent Qdrant point.
  - Root baggage page chunks can remain indexed only as fallback/debug records, not the primary retrieval unit for directory queries.
- Change retrieval routing for directory queries.
  - If `sourceType=baggage_directory` or the query explicitly asks “according to the CheapOair baggage fees page”, route to row mode first.
  - Detect airlines, facet, comparison intent, and route-scope tokens like `USA`, `Canada`, `domestic`, `international`, `within`.
  - Single-airline query: exact-match airline rows first, then score by route-scope overlap and facet completeness.
  - Comparison query: fetch each airline’s best row independently, then merge results. Do not let two airlines compete in one global vector search.
  - If exact row lookup misses, run **HyDE over `baggage_directory_row` points only**. Fall back to root-page chunks only if row retrieval fails.
- Improve privacy retrieval granularity.
  - Promote bold subsection labels inside `PERSONAL INFORMATION` into virtual headings before chunking, so `Personal Information We May Collect`, `How We May Use Personal Information`, and `How Personal Information May Be Disclosed` become separately retrievable units.
  - Trim policy footer/app/banner noise after the real privacy content ends.
  - For multi-aspect privacy queries, add one extra HyDE plan per detected aspect (`collect`, `use`, `disclose`, `security`, `retention`) and fuse the results.

## Public Interfaces
- Keep existing `filter.sourceType=baggage_directory` behavior, but internally map it to row retrieval first.
- Add optional support for `filter.sourceType=baggage_directory_row` for debugging and benchmarks.
- Extend returned citations/results with:
  - `rowId`
  - `routeScope`
  - `sourceType` showing `baggage_directory_row` when applicable
- Do not reintroduce SQLite/FTS. Qdrant remains the only active retrieval store.

## Test Plan
- Parser correctness:
  - Aegean row with inline carry-on text
  - Air Canada row with `Weight: Na`
  - Aeromexico row with duplicated carry-on text
  - Air India and Air France row extraction
  - Multi-route airlines like Aer Lingus / WestJet
- Retrieval correctness:
  - Single-airline directory lookup returns the correct row and facet text
  - Directory comparisons return one correct row per airline
  - Route-scope disambiguation works when multiple rows exist for one airline
  - No wrong-airline leakage in comparison queries
  - Privacy multi-aspect query retrieves both `collect` and `disclose`
- Benchmark acceptance:
  - Overall: `>= 90/100`
  - `directory_single`: `>= 34/40`
  - `directory_compare`: `>= 8/10`
  - `privacy_single`: `15/15`
  - `privacy_multi`: target `15/15`, minimum `14/15`
  - `official_policy`: `10/10`
  - `negative`: `10/10`

## Assumptions
- Default chosen: **Structured Hybrid** for the root baggage directory, **Mandatory HyDE** everywhere else.
- Official airline policy pages remain the authority for airline-policy queries; the CheapOair root baggage page remains the authority for “according to CheapOair” directory queries.
- If a query does not specify route scope and multiple rows exist for the same airline, retrieval should return the best row plus one alternate route row rather than silently guessing one.
