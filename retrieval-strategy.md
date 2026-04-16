# Retrieval Strategy

This document explains how the current KB retrieval flow works from a user query to the final chunks returned to the OpenAI Agents SDK tool.

## High-Level Flow

User query enters the Express chat route registered in `src/api/routes.js` and handled by `src/api/handlers.js`.

The route accepts only natural language:

```json
{
  "query": "What is American Airlines baggage policy from NYC to LAX?"
}
```

The route calls `answerQuery()` from `src/agents/kb-chat-service.js`.

The agent is configured with one tool: `retrieve_context`.

The agent must call `retrieve_context` before answering because `modelSettings.toolChoice = "required"`.

The tool is defined in `src/agents/retrieve-context-tool.js`.

The tool calls `RetrievalService.retrieve()` through `src/retrieval/service.js`.

`RetrievalService` decides whether to use structured baggage-directory retrieval or normal semantic vector retrieval.

Retrieved chunks are returned to the agent with stable citation indexes.

The agent answers only from the retrieved tool output and cites chunks like `[1]`.

## Indexed Data Types

`baggage_directory_row`

These are structured rows extracted from the CheapOair baggage directory. Each row has fields such as `airlineName`, `routeScope`, `carryOnCost`, `carryOnWeight`, `carryOnSize`, `firstBagUrl`, `secondBagUrl`, and `additionalPolicyUrl`.

Example:

```json
{
  "sourceType": "baggage_directory_row",
  "airlineName": "American Airlines",
  "routeScope": "Within (USA,Puerto Rico,US Virgin island,Canada,Hawaii)",
  "carryOnCost": "Free",
  "carryOnSize": "45\" (22 x 14 x 9)",
  "firstBagUrl": "https://www.aa.com/i18n/travel-info/baggage/checked-baggage-policy.jsp"
}
```

`airline_policy`

These are chunks from official airline pages discovered from the directory row links. These pages contain checked-bag fees, size/weight limits, special baggage, and airline-specific rules.

`privacy_policy`, `cookie_policy`, `terms_conditions`

These are normal page chunks from CheapOair policy pages. They are retrieved semantically using vector search and HyDE.

## Step 1: Query Routing

The retrieval service first detects the query type.

If the query looks like a baggage query, it enters directory-row mode. This is triggered by natural baggage terms like `baggage policy`, `carry-on`, `checked baggage`, or `luggage`.

The public `/api/chat` route does not accept user-provided filters. Filters are inferred only inside the agent/tool layer when the natural-language query clearly implies a source family, airline, URL, or baggage facet.

If the query is not a baggage query, it uses semantic vector search over the indexed policy chunks.

Example:

```text
I have a flight from NYC to LAX on American Airlines in economy class, what will be the baggage policy?
```

This becomes a baggage query, so retrieval starts with `baggage_directory_row` instead of searching the whole vector database blindly.

## Step 2: Airline Matching

For baggage queries, retrieval lists available airline names from Qdrant and matches the user query against airline aliases.

The code avoids unsafe one-word aliases that create false matches. For example:

`New York` should not match `Air New Zealand` just because of the word `New`.

`Blue fare` should not match `Blue Islands` when the intended airline is `JetBlue Airways`.

`Denver to Orlando` should not match `Denver Air Connection` when Denver is only the origin city.

This is handled through ambiguous alias suppression in `makeAirlineAliases()`.

## Step 3: Route Understanding

For route-specific baggage queries, retrieval builds a route profile from location words and airport/city hints.

Examples of supported signals:

`NYC`, `JFK`, `LAX`, `Chicago`, `Las Vegas`, `Honolulu`, and `Maui` map to USA.

`Toronto`, `Vancouver`, and `Calgary` map to Canada.

`Dubai` maps to UAE.

`Frankfurt` maps to Germany.

`Amsterdam` maps to Netherlands.

`Istanbul` maps to Turkey.

`Doha` maps to Qatar.

If a query has multiple countries, it is treated as international route intent.

If a query says `to` or `from`, route scoring prefers rows like `To/From USA/Canada` and penalizes exception rows like `Anywhere to Anywhere Except To/From USA and Canada`.

Example:

```text
Emirates Airlines Dubai to JFK economy carry-on size weight and checked baggage allowance.
```

The route profile detects `Dubai` as UAE and `JFK` as USA. The selected row becomes:

```text
Emirates Airlines | To/From USA/ Canada
```

The wrong exception row is avoided:

```text
Anywhere to Anywhere Except To/From USA and Canada
```

## Step 4: Directory Row Scoring

Each candidate baggage row is scored using:

Exact airline match.

Route scope match.

Facet completeness, for example carry-on size/weight/cost or checked-bag policy URL availability.

Keyword overlap from the user query.

Example:

```text
KLM Amsterdam to New York economy carry-on and checked baggage rules.
```

The correct top row is:

```text
KLM | To/From USA/Canada
```

This avoids the old false positive:

```text
Air New Zealand | To/From USA
```

## Step 5: Linked Policy Expansion

Directory rows usually contain links to official airline policy pages.

For checked-bag queries, the retrieval service expands the directory row using `firstBagUrl` or `secondBagUrl`.

For broader baggage-policy queries, it also uses `additionalPolicyUrl`.

The linked policy lookup searches by URL first. It tries URL variants with and without trailing slash and with both `http` and `https`.

The linked policy lookup retrieves multiple candidates and applies a small facet-aware reranker.

For `first_checked_bag` and `second_checked_bag`, the reranker prefers chunks containing words like `checked`, `hold baggage`, `allowance`, `fees`, `weight`, `dimension`, and `size`.

It penalizes carry-on-only chunks when the facet is checked baggage.

Example:

```text
What are American Airlines checked baggage size and weight limits for NYC to LAX economy?
```

The retrieval returns:

```text
American Airlines | Within USA... | baggage_directory_row
American official checked bag policy | Weight and size / checked allowance chunk
```

## Step 6: Semantic Vector Retrieval

For non-baggage queries, retrieval uses vector search directly.

The search plan includes:

Original user query embedding.

Airline-focused query embedding when an airline is detected.

HyDE hypothetical passage embedding generated by the OpenAI Agents SDK path.

Additional HyDE variants for multi-aspect privacy queries.

Results from these searches are fused with Reciprocal Rank Fusion.

Then a small keyword bonus is applied for exact query-token overlap and airline-name overlap.

Example:

```text
What personal information does CheapOair collect, use, disclose, secure, and retain?
```

This uses privacy semantic retrieval plus privacy topic coverage to make sure the answer includes collection, use, disclosure, security, and retention evidence.

## Step 7: Privacy Topic Coverage

Privacy queries can ask for multiple aspects in one question.

If the initial vector results miss a required topic, retrieval does targeted follow-up searches for the missing topic.

Example topics:

Collection.

Use.

Disclosure.

Security.

Retention.

This avoids returning only the top semantically similar privacy chunk when the user asks for several policy aspects.

## Step 8: Agent Tool Output

The retrieval tool returns compact JSON to the agent:

```json
{
  "query": "user question",
  "resultCount": 2,
  "results": [
    {
      "citationIndex": 1,
      "url": "https://www.cheapoair.com/travel/baggage-fees/",
      "sourceType": "baggage_directory_row",
      "airlineName": "American Airlines",
      "routeScope": "Within (USA,Puerto Rico,US Virgin island,Canada,Hawaii)",
      "text": "..."
    },
    {
      "citationIndex": 2,
      "url": "https://www.aa.com/i18n/travel-info/baggage/checked-baggage-policy.jsp",
      "sourceType": "airline_policy",
      "text": "..."
    }
  ]
}
```

The agent uses this output to answer with citations.

## 30-Query Verification

Final report files:

`data/logs/retrieval-30-final.json`

`data/logs/retrieval-30-final.md`

Final result:

```text
28 pass
2 partial
0 fail
30 total
```

## Remaining Partial Cases

`BG020 Hawaiian Airlines Honolulu to Maui carry-on baggage policy and checked bag info`

The correct Hawaiian directory row is retrieved for `Within Hawaiian Neighbor Island`, and the official Hawaiian fee URL is expanded. The partial reason is that the official fee page text in the index does not expose clear `checked` wording in the retrieved chunk. It is a source/content-quality limitation, not an airline routing miss.

`BG021 Spirit Airlines Chicago to Las Vegas personal item, carry-on, and checked bag prices`

The correct Spirit directory row is retrieved, but the official Spirit URL crawled as `403 Access denied` and is marked `retrievalAllowed=false`. Because the official policy page is unusable, linked policy expansion cannot return checked-bag or personal-item details. This is a crawl/source-access limitation.

## Practical Debugging Checklist

If a baggage query returns partial evidence, check whether the top result is the right `baggage_directory_row`.

If the row is right but checked-bag details are missing, check whether `linkedPolicyHitCount` is greater than zero in the retrieval trace.

If `linkedPolicyHitCount` is zero, verify whether the official URL exists in Qdrant and whether it is marked `retrievalAllowed=true`.

If the wrong airline appears, inspect airline aliases and suppress ambiguous one-token aliases.

If the wrong route row appears, inspect `buildRouteProfile()` and add missing city/country/airport terms.

If policy pages return shallow chunks, improve crawling or chunking for that source page.
