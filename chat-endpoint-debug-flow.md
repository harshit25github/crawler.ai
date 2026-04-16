# `/api/chat` Debug Flow In Hinglish

This document explains the complete user-query flow for the chat endpoint, from config setup to final API response.

Example request:

```http
POST /api/chat
Content-Type: application/json
```

```json
{
  "query": "What is American Airlines baggage policy from NYC to LAX?"
}
```

Important point: user only sends natural language `query`. User does not send `filter`, `topK`, `sourceType`, `airline`, or `facet` in `/api/chat`. Agent/tool layer internally infers those things.

## 1. Config Setup

File: `src/indexing/config.js`

Lines `1-3`:

- `dotenv/config` load hota hai, so `.env` variables automatically `process.env` me available ho jaate hain.
- `process` environment values read karne ke liye use hota hai.
- `resolve` local folders like `data/`, `raw/`, `chunks/`, `traces/` build karne ke liye use hota hai.

Lines `5-17`: `readNumber(name, fallback)`

- Numeric env values read karta hai.
- Env missing ho to fallback use hota hai.
- Env present ho but number nahi ho to error throw hota hai.
- Example: `PORT`, `DEFAULT_TOP_K`, `CHUNK_TARGET_CHARS`.

Lines `19-21`: `readString(name, fallback)`

- String env values read karta hai.
- Empty/missing value ho to fallback use hota hai.
- Example: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `QDRANT_URL`.

Lines `23-53`: `config`

- `port`: API server port, default `3000`.
- `openAiApiKey`: OpenAI chat, agent, HyDE, and embedding calls ke liye required.
- `openAiBaseUrl`: OpenAI-compatible API base URL.
- `openAiChatModel`: chat agent and HyDE agent model, default `gpt-4o-mini`.
- `openAiEmbeddingModel`: embedding model, default `text-embedding-3-small`.
- `qdrantUrl`: Qdrant server URL.
- `qdrantCollection`: Qdrant collection name, default `url_kb`.
- `defaultTopK`: default retrieval result count, default `6`.
- `paths`: local data/log/artifact paths.

Chat ke liye config impact:

- `OPENAI_API_KEY` missing hai to `/api/chat` fail hoga.
- `QDRANT_URL` ya `QDRANT_COLLECTION` wrong hai to retrieval zero/failed ho sakta hai.
- `OPENAI_CHAT_MODEL` final agent answer and HyDE passage dono me use hota hai.

## 2. Server Startup

File: `src/server.js`

Lines `1-4`:

- `config` import hota hai from `src/indexing/index.js`.
- `buildApp` import hota hai from `src/api/app.js`.

Lines `6-18`: `startServer(...)`

- Express app ko listen karwata hai.
- Default host `0.0.0.0`.
- `app.listen(port, host, callback)` ke through server start hota hai.
- Server start hone ke baad console me URL print hota hai.

Lines `20-29`: direct run check

- Agar file directly run hui hai, for example `node src/server.js`, tab server start hota hai.
- `buildApp({ enableTestInject: false })` production-style app banata hai.
- `port: config.port` means `.env` / default config se port use hota hai.

## 3. Express App Build

File: `src/api/app.js`

Line `7`: `buildApp({ enableTestInject = true } = {})`

- App always internally `createKbSystem()` call karta hai.
- Yahi point hai jahan crawler, indexing, retrieval, Qdrant, OpenAI service, and answer agent wire hote hain.

Line `8`: `const kb = createKbSystem()`

- Real KB system create hota hai.
- Is codebase me custom KB dependency pass nahi kar rahe, so app factory always production/runtime dependency graph banata hai.

Line `9`: `const app = express()`

- Express app instance create hoti hai.

Line `11`: `app.disable("x-powered-by")`

- Security hygiene. Express default `X-Powered-By` header remove karta hai.

Line `12`: `app.use(express.json({ limit: "1mb" }))`

- JSON body parser.
- `/api/chat` body yahin parse hota hai.
- Body max `1mb`.

Line `14`: `registerApiRoutes(app, kb)`

- Routes attach hote hain.
- Important chat route yahin register hota hai.

Line `15`: `app.use(errorHandler)`

- Agar route/handler me error throw hota hai, centralized JSON error response return hota hai.

Lines `17-19`: test inject compatibility

- Tests me `app.inject()` support ke liye helper attach hota hai.
- Production chat flow me required nahi.

Line `21`: configured Express app return hoti hai.

## 4. KB System Creation

File: `src/services/kb-system.js`

Lines `1-10`: imports

- Indexing module se config and service classes import hote hain.
- Crawler module se `Crawl4AIClient`.
- Retrieval module se `RetrievalService`.
- Agent module se `createAnswerQuery`.

Lines `12-25`: `buildKbConfig(configOverride)`

- Base config ko optional override ke saath merge karta hai.
- `chunking` and `paths` nested objects safely merge hote hain.
- Test/custom environment me override possible hai.

Lines `27-68`: `createKbSystem(configOverride)`

- Runtime dependency container hai.
- Line `28`: final config ready hota hai.
- Line `29`: `Crawl4AIClient` create hota hai. Chat directly crawler use nahi karta, but same KB system me available hai.
- Line `30`: `OpenAIService` create hota hai. Embeddings and HyDE passage generation yahin se aate hain.
- Line `31`: `QdrantService` create hota hai. Vector DB operations yahin se hote hain.
- Lines `32-43`: import/ingestion services create hote hain. Chat path me directly use nahi hote.
- Lines `44-48`: `RetrievalService` create hota hai with `config`, `openAiService`, `qdrantService`.
- Lines `49-52`: `answerQuery` create hota hai. This is the function `/api/chat` calls.
- Lines `54-67`: final `kb` object return hota hai with `retrieve` and `answerQuery`.

## 5. Route Registration

File: `src/api/routes.js`

Line `4`: `registerApiRoutes(app, kb)`

- Same `kb` object route handlers ko diya jata hai.

Line `5`: `const handlers = createApiHandlers(kb)`

- Handlers close over `kb`.
- Iska matlab handlers ke paas `kb.answerQuery`, `kb.retrieve`, `kb.ingestUrls` available hote hain.

Line `10`: `app.post("/api/chat", asyncHandler(handlers.chat))`

- Yeh actual user-query route hai.
- `asyncHandler` wrap karta hai so async errors centralized error handler tak jayein.

## 6. Request Helpers

File: `src/api/request-utils.js`

Lines `1-8`: `asyncHandler(handler)`

- Route handler ko `try/catch` me wrap karta hai.
- Agar handler throw kare, `next(error)` call hota hai.

Lines `11-13`: `sendBadRequest(response, message)`

- 400 JSON error response return karta hai.

Lines `15-17`: `normalizeQuery(value)`

- Agar `query` string hai to trim karta hai.
- Agar query missing ya non-string hai to empty string return karta hai.

Lines `19-28`: `errorHandler(...)`

- Unhandled errors ko JSON response me convert karta hai.
- Status `error.statusCode` ya default `500`.

## 7. `/api/chat` Handler

File: `src/api/handlers.js`

Lines `62-75`: `chat(request, response)`

Line `63`: `const body = request.body || {}`

- JSON body read hota hai.
- Example body:

```json
{
  "query": "What is American Airlines baggage policy from NYC to LAX?"
}
```

Line `64`: `const query = normalizeQuery(body.query)`

- Query trim hoti hai.
- Example normalized query:

```text
What is American Airlines baggage policy from NYC to LAX?
```

Lines `66-69`: empty query validation

- Agar query missing hai, API response:

```json
{
  "error": "query is required."
}
```

Lines `71-72`: important comment

- Public chat natural-language only hai.
- User filters nahi bhejta.
- Filter inference agent/tool instructions se hoti hai.

Line `73`: `const result = await kb.answerQuery({ query })`

- Yahi jump hai API layer se agentic layer me.
- Sirf query pass hoti hai.

Line `74`: `response.json(result)`

- `answerQuery` ka final output directly API response ban jata hai.

## 8. `answerQuery()` Starts The Agentic Flow

File: `src/agents/kb-chat-service.js`

Lines `1-12`: imports

- `OpenAI` SDK client.
- `run`, `setDefaultOpenAIClient`, `setOpenAIAPI` from OpenAI Agents SDK.
- `createChatAgent`.
- `createCitationRegistry`.
- `createRetrieveContextTool`.
- `logChatInteraction`.

Lines `14-16`: `buildTraceId()`

- Har chat request ke liye unique trace id banata hai.
- Logs me correlation ke liye useful.

Lines `18-28`: `sanitizeHistory(history)`

- Last 8 user/assistant messages keep karta hai.
- Current `/api/chat` handler history pass nahi karta, so default empty history.

Line `30`: `createAnswerQuery({ config, retrievalService })`

- This creates the function used by `/api/chat`.
- It closes over config and retrieval service.

Line `31`: `let openAiClient = null`

- OpenAI client cache hota hai.
- First request me create hota hai, later requests me reuse hota hai.

Lines `33-40`: returned `answerQuery(...)`

- Inputs support `query`, `topK`, `filter`, `history`, `requestSource`, `debugContext`.
- `/api/chat` only sends `query`.
- `topK`, `filter`, `history` default undefined/empty.

Lines `41-42`:

- `traceId` created.
- `toolTraceCollector = []` creates in-memory trace for all retrieval tool calls in this one chat run.

Lines `45-47`: API key guard

- Agar `OPENAI_API_KEY` missing hai, chat answer impossible.
- Error throw hota hai and Express error handler JSON error return karta hai.

Lines `49-56`: OpenAI client setup

- First time only:
- `new OpenAI({ apiKey, baseURL })`.
- `setOpenAIAPI("chat_completions")` tells Agents SDK to use Chat Completions backend.
- `setDefaultOpenAIClient(openAiClient)` makes this client default for Agents SDK.

Line `58`: `createCitationRegistry()`

- Stable `[1]`, `[2]` citations maintain karta hai.
- Same chunk multiple tool calls me aaye to same citation index reuse hota hai.

Lines `59-68`: `createRetrieveContextTool(...)`

- Agent ke liye function tool create hota hai.
- It closes over `retrievalService`, citation registry, default topK, config, trace id, and trace collector.

Lines `69-72`: `createChatAgent({ config, retrieveContextTool })`

- Per-request agent create hota hai.
- Is agent ke paas exactly one tool hai: `retrieve_context`.

Lines `73-80`: `run(agent, input, { maxTurns: 6 })`

- OpenAI Agents SDK run starts.
- `buildAgentConversationInput` se prompt input banta hai.
- `maxTurns: 6` means agent multiple tool-call/LLM turns kar sakta hai, but infinite loop nahi.

Line `81`: final output text

- Agent final answer ko string me convert karta hai.

Line `82`: chunks from citation registry

- Jo chunks tool ne register kiye, woh yahan collect hote hain.

Lines `89-107`: no chunks case

- Agar retrieval tool ne zero chunks return kiye, fixed answer return hota hai:

```text
I could not find relevant chunks in the indexed URL knowledge base.
```

Lines `109-126`: success case

- Final response contains `answer`, `citations`, and `chunks`.
- Interaction log write hota hai.

Lines `127-147`: error path

- Error also logged.
- Error rethrow hota hai so Express error handler JSON error return kare.

## 9. Agent Configuration

File: `src/agents/chat-agent.js`

Lines `4-23`: `buildAgentConversationInput`

- History sanitize karta hai.
- Current user question ko prompt input me add karta hai.
- Example final input:

```text
Current user question:
What is American Airlines baggage policy from NYC to LAX?
```

Lines `25-47`: `createChatAgent(...)`

- Line `27`: agent name is `URL Knowledge Base Agent`.
- Line `28`: model is `config.openAiChatModel`.
- Lines `29-38`: instructions force grounded behavior.
- Line `39`: `tools: [retrieveContextTool]`.
- Lines `40-43`: `toolChoice: "required"` means first model turn must call tool.
- Line `42`: `parallelToolCalls: false` keeps debugging simple.
- Line `44`: `resetToolChoice: true` means after first required call, model can answer or call tool again.
- Line `45`: `toolUseBehavior: "run_llm_again"` means after tool result, SDK runs LLM again for final answer.

Agent instructions ka practical meaning:

- User se filters mat mango.
- Natural language se airline/route/facet infer karo.
- Tool output ke bahar se answer mat banao.
- Har material claim me `[1]`, `[2]` citation do.

## 10. Retrieval Tool Schema And Execution

File: `src/agents/retrieve-context-tool.js`

Lines `4-5`:

- `MAX_AGENT_TOOL_TOP_K = 8`.
- Tool name is `retrieve_context`.

Lines `7-10`: `sanitizeTopK`

- TopK positive integer hai to accept.
- Invalid topK ignored.

Lines `12-18`: `sanitizeFilter`

- Empty/null/undefined filter values remove karta hai.

Lines `20-25`: `mergeRequestFilter`

- Tool-inferred filter and base filter merge hote hain.
- Base filter wins on conflict.
- `/api/chat` base filter undefined hota hai, so agent/tool inferred filter apply ho sakta hai.

Lines `27-37`: `resolveToolTopK`

- Tool topK, base topK, default topK me se choose hota hai.
- Maximum clamp `8`.
- Example `/api/chat` me no topK, config default `6`, so applied topK normally `6`.

Lines `39-50`: `chunkRegistryKey`

- Dedup/citation key priority:
- `rowId`
- `sectionId`
- `id`
- fallback: `url|sectionTitle|sectionPath|chunkIndex`

Lines `53-64`: `mergeChunkRecord`

- Same chunk dobara aaye to non-empty fields merge hote hain.
- Citation index same rehta hai.

Lines `66-75`: `buildCitations`

- Full chunk se compact citation metadata banta hai.

Lines `105-203`: `createRetrieveContextExecutor`

- This is the real function run when agent calls tool.

Line `116`: tool input normalize hota hai.

Example possible tool input generated by agent:

```json
{
  "query": "American Airlines baggage policy from NYC to LAX economy carry-on and checked baggage",
  "topK": 6,
  "filter": {
    "airline": "American Airlines"
  }
}
```

Lines `117-118`: tool query extract and trim.

Lines `119-122`: tool call index calculate.

Lines `123-130`: initial retrieval trace entry:

- `tool_input_received`
- original tool input
- query

Lines `132-134`: empty tool query invalid.

Lines `136-141`: `appliedTopK`

- Example appliedTopK `6`.
- Never above `8`.

Line `142`: `appliedFilter`

- Example:

```json
{
  "airline": "American Airlines"
}
```

Lines `143-147`: trace records resolved topK/filter.

Lines `150-154`: actual retrieval call:

```js
retrievalService.retrieve(query, {
  topK: appliedTopK,
  filter: appliedFilter,
  trace: retrievalTrace
})
```

Lines `155-156`: citation registry registers results.

- Each result gets stable `citationIndex`.

Lines `157-164`: tool payload returned to agent.

Tool output shape:

```json
{
  "query": "...",
  "appliedTopK": 6,
  "appliedFilter": { "airline": "American Airlines" },
  "resultCount": 2,
  "results": [
    {
      "citationIndex": 1,
      "url": "...",
      "title": "...",
      "sourceType": "baggage_directory_row",
      "airlineName": "American Airlines",
      "routeScope": "Anywhere to Anywhere",
      "sectionPath": [],
      "text": "...",
      "score": 10.5
    }
  ]
}
```

Lines `165-177`: tool log entry prepare hoti hai.

- Includes traceId, query, appliedTopK, appliedFilter, result summaries, retrievalTrace.

Lines `179-184`: trace collector and JSONL log write.

- In-memory collector answerQuery ke paas rehta hai.
- JSONL log file: `data/logs/retrieve-context-tool.jsonl`.

Lines `187-203`: error path.

- Retrieval error bhi tool log me record hota hai.
- Error rethrow hota hai so agent/API fail correctly.

Lines `206-291`: `createRetrieveContextTool`

- OpenAI Agents SDK `tool(...)` helper use hota hai.
- Tool name `retrieve_context`.
- Description agent ko guide karta hai.
- Tool JSON schema has required `query`, optional `topK`, and optional `filter`.
- Filter supports `domain`, `url`, `sourceType`, `airline`, `facet`.

## 11. Retrieval Service Entry

File: `src/retrieval/service.js`

Lines `661-729`: `retrieve(query, options = {})`

This is main retrieval function.

Lines `662-664`: non-empty query required.

Lines `666-670`: embedding support check.

- `OPENAI_API_KEY` required because query/HyDE vectors generate karne hain.

Lines `672-676`: chat support check.

- HyDE passage generation ke liye OpenAI chat support required.

Line `678`: `topK`

- Tool se passed topK ya default config.

Line `679`: `filter`

- Tool-inferred or empty object.

Line `680`: `trace`

- Tool ne retrievalTrace array pass kiya hai, retrieval steps isi me push hote hain.

Line `681`: `facet`

- `filter.facet` available ho to use hota hai.
- Warna query se detect hota hai.

Line `682`: `directoryMode`

- `shouldUseDirectoryRowMode(query, filter)` decide karta hai.
- Baggage query usually directory mode trigger karti hai.

Lines `683-686`: `airlineSourceType`

- Directory mode ho to airline list `baggage_directory_row` se aati hai.
- Otherwise `airline_policy`.

Lines `687-695`: `availableAirlines`

- Agar baggage/airline relevant query hai to Qdrant se airlines list hoti hai.
- Uses `qdrantService.listAirlines`.

Line `696`: `routeAirlines(...)`

- User query me airline name match karta hai.
- Example: query contains `American Airlines`, so routedAirlines includes American Airlines.

Lines `698-708`: trace `retrieve_started`.

- Logs query, topK, filter, facet, directoryMode, source type, airline count, routedAirlines.

Lines `710-715`: requested airline no match case.

- Agar filter.airline diya gaya but index me match nahi mila, empty results.

Lines `717-729`: directory branch.

- If directoryMode true, `retrieveDirectoryRows(...)` call hota hai.
- Return hota hai with citations.

Lines `731-755`: vector branch.

- Non-directory query ke liye `retrieveVectorHits(...)`.
- Privacy policy source type ho to topic coverage repair.
- Final hits get citations.

## 12. Why American Airlines Baggage Query Uses Directory Mode

File: `src/retrieval/helpers.js`

Lines `10-15`:

- Regex patterns define baggage query detection.
- `NATURAL_BAGGAGE_QUERY_PATTERN` catches words like:
- `baggage policy`
- `baggage rules`
- `carry-on`
- `checked baggage`
- `luggage`

Lines `430-445`: `shouldUseDirectoryRowMode(query, filter)`

- If filter sourceType explicitly non-baggage hai, false.
- Otherwise directory mode true if:
- sourceType is `baggage_directory`
- sourceType is `baggage_directory_row`
- query mentions CheapOair baggage fees page
- natural baggage query pattern matches.

Example:

```text
What is American Airlines baggage policy from NYC to LAX?
```

- Contains `baggage policy`.
- Therefore directory mode true.

## 13. Query Understanding Helpers

File: `src/retrieval/query-routing.js`

Lines `1-30`: stop words

- General words remove/ignore hote hain during query token logic.

Lines `32-39`: generic airline words

- `air`, `airlines`, `airways` jaise words airline alias matching me special handle hote hain.

Lines `41-72`: non-airline tokens

- `baggage`, `policy`, `fee`, `carry`, etc. ko airline name samajhne se avoid karta hai.

Lines `73-81`: ambiguous single-token aliases

- Example `blue`, `canada`, `france`.
- Isse false airline matches avoid hote hain.

Lines `83-109`: privacy aspect patterns

- Privacy queries me collect/use/disclose/security/retention detect hota hai.

Lines `111-121`: route scope tokens

- USA, Canada, domestic, international, within, between, except, from, to.

Lines `123-154`: baggage facets

- carry-on, first checked bag, second checked bag, oversize, overweight, special items, policy.

Lines `156-166`: normalize/tokenize

- Query lowercase hoti hai, non-alphanumeric spaces me convert hote hain, tokens bante hain.

Lines `185-193`: `detectFacet`

- Query facet detect karta hai.

Lines `195-205`: `detectPrivacyAspects`

- Privacy aspects detect karta hai.

Lines `207-215`: comparison/route hints.

Lines `218-247`: `makeAirlineAliases`

- Airline name ke aliases create hote hain.
- Example American Airlines:
- `american airlines`
- `american`

## 14. Directory Row Retrieval

File: `src/retrieval/service.js`

Lines `230-378`: `retrieveDirectoryRows(...)`

Line `238`: comparison query detect.

- Example query is not comparison.

Line `239`: route scope hints.

- Query has `NYC` and `LAX`, route profile later sees USA-related route.

Line `240`: `buildRouteProfile(query)`

- Converts route words/cities/airports into route intent.

Line `241`: field intent.

- If query asks `cost`, `weight`, `size`, notes, that field intent is detected.

Line `242`: airline targets.

- Based on routed airlines/filter.
- Example: `["American Airlines"]`.

Lines `245-255`: trace `directory_row_mode_started`.

- Logs route intent, facet, comparison, airline targets.

Lines `257-259`: list directory rows for each airline.

- Calls `qdrantService.listDirectoryRows({ airline })`.
- This scrolls Qdrant payloads where:
- `sourceType = baggage_directory_row`
- `airlineName = American Airlines`
- `retrievalAllowed = true`

Lines `260-273`: score rows.

- `scoreDirectoryRow` gives score by airline match, route scope, requested facet, field completeness, and row richness.

Lines `274-288`: trace scored rows.

- Logs fetched rows, positive rows, top route scopes, carry-on details.

Lines `290-296`: select best rows.

- For non-comparison, picks best matching row.

Lines `299-305`: dedupe and exactEnough.

- Dedup by `rowId`/`sectionId`/`id`.
- Exact enough if at least one good row found.

Lines `306-313`: linked policy expansion.

- If query asks full baggage policy or checked bag details, it expands from row URLs into official airline policy chunks.

Lines `315-321`: trace exact hits.

Lines `323-325`: if exact enough, return hits.

- For American baggage policy, usually row hit plus linked policy hit can be returned.

Lines `327-356`: vector fallback over directory rows.

- Agar exact row enough nahi, vector search over `baggage_directory_row`.

Lines `358-377`: fallback over directory page chunks.

- Last fallback.

## 15. Route Profile And Route Matching

File: `src/retrieval/helpers.js`

Lines `16-39`: airport/country/city patterns.

- `NYC`, `LAX`, `Los Angeles`, `New York`, etc. USA pattern me included.

Lines `561-656`: `buildRouteProfile(text)`

- Text normalize karta hai.
- Countries/cities detect karta hai.
- `hasUsa`, `hasCanada`, `hasDomestic`, `hasInternational`, `hasToFrom` flags build karta hai.

Example query:

```text
What is American Airlines baggage policy from NYC to LAX?
```

- `NYC` and `LAX` both USA pattern match.
- `matchedCountries = ["usa"]`.
- Because query has `from` / `to`, inferred domestic true.
- This helps rows like domestic/USA scope rank better.

Lines `670-727`: `routeScopeScore(routeIntent, row)`

- Query route intent vs row route scope compare hota hai.
- Matching USA/domestic rows boost hote hain.
- Exception rows, like `Except USA/Canada`, penalize hote hain when user route includes USA/Canada.

## 16. Linked Policy Expansion

File: `src/retrieval/helpers.js`

Lines `46-67`: linked policy facets.

- `first_checked_bag` -> `firstBagUrl`
- `second_checked_bag` -> `secondBagUrl`
- `additional_policy` -> `additionalPolicyUrl`

Lines `457-489`: `detectLinkedPolicyFacetRequests`

- If query asks checked baggage, first bag, baggage policy, baggage fees, it requests linked policy lookup.
- If full baggage policy, it may add both first checked bag and additional policy lookup.

Lines `491-499`: `buildLinkedPolicyQueries`

- Original query plus focused instruction:

```text
What is American Airlines baggage policy from NYC to LAX?
Focus specifically on 1st bag details for American Airlines.
Route scope: ...
```

Lines `501-530`: pick best linked policy hit.

- Checked baggage pages get boost if text mentions checked/hold baggage, allowance, fee, weight, dimensions.
- Carry-on-only chunks get penalty for checked-bag request.

Lines `533-558`: URL variants.

- Handles trailing slash and http/https variants.

File: `src/retrieval/service.js`

Lines `380-458`: `fetchLinkedPolicyHit`

- Uses row URL like `firstBagUrl`.
- Runs vector search with:

```json
{
  "sourceType": "airline_policy",
  "facet": "first_checked_bag",
  "url": "official airline policy URL"
}
```

- If exact URL match fails, fallback by airline:

```json
{
  "sourceType": "airline_policy",
  "facet": "first_checked_bag",
  "airline": "American Airlines"
}
```

Lines `460-543`: `expandDirectoryRowsWithLinkedPolicy`

- Detects if linked policy needed.
- For each directory row, fetches linked policy hit.
- Orders results based on query type.
- Dedupes final ordered hits.

## 17. Vector Retrieval And HyDE

File: `src/retrieval/service.js`

Lines `38-161`: `buildSearchPlans(...)`

Line `39-45`: base search plan.

- Original query is always a search plan.

Lines `55-65`: airline-specific plan.

- If routed airline exists, another plan is created:

```text
American Airlines
What is American Airlines baggage policy from NYC to LAX?
```

Lines `68-75`: HyDE request.

- HyDE means hypothetical document expansion.
- Weight `1.25`, so HyDE search is slightly stronger.

Lines `76-79`: privacy-specific HyDE aspects.

- Only when sourceType is privacy_policy.

Lines `95-104`: multiple privacy HyDE requests if needed.

Lines `107-114`: generate hypothetical passages.

- Calls `openAiService.generateHypotheticalDocument`.

Lines `116-130`: prepend HyDE passage to plans.

- HyDE text becomes a searchable embedding input.

Lines `153-160`: embeddings.

- All plan texts are embedded.
- Returned plan includes vector.

File: `src/indexing/openai-service.js`

Lines `91-123`: HyDE generation.

- Builds scope from filter.
- Sets OpenAI Agents SDK default client.
- Runs internal agent `HyDE Passage Generator`.
- Output is a short source-like passage.

Lines `29-46`: embeddings.

- Calls OpenAI `/embeddings`.
- Model from `config.openAiEmbeddingModel`.
- Returns embedding vectors.

File: `src/retrieval/service.js`

Lines `163-228`: `retrieveVectorHits(...)`

- Builds search plans.
- Builds airline targets.
- Runs Qdrant query for each search plan and airline target.
- Normalizes hits.
- Fuses ranked lists.

File: `src/retrieval/helpers.js`

Lines `374-428`: `fuseRankedLists`

- Uses Reciprocal Rank Fusion.
- Same chunk across multiple searches merges into one.
- Score formula includes `weight / (RRF_K + rank)`.
- Then keyword bonus is added.
- Final hits sorted by score.

## 18. Qdrant Calls

File: `src/indexing/qdrant-service.js`

Lines `22-72`: `buildPayloadFilter`

- Converts internal filter to Qdrant filter.
- Supported fields:
- `url`
- `domain`
- `sourceType`
- `airline` -> payload key `airlineName`
- `rowId`
- `retrievalAllowed`

Lines `74-81`: constructor

- Base URL and collection loaded from config.
- API key header added if configured.

Lines `240-267`: `scrollPoints`

- Used for listing airlines and directory rows.
- Calls Qdrant `/points/scroll`.
- Handles pagination using `next_page_offset`.

Lines `269-296`: `listAirlines`

- Scrolls points by sourceType and `retrievalAllowed`.
- Builds unique airline list from payload.

Lines `298-315`: `listDirectoryRows`

- Scrolls `baggage_directory_row` records for a specific airline.
- Returns payload rows.

Lines `317-346`: `query`

- Calls Qdrant `/points/query`.
- Sends vector, limit, payload filter.
- Returns hits with payload fields flattened.

## 19. Tool Result To Agent Answer

After retrieval returns chunks:

1. `retrieve-context-tool.js` registers chunks in citation registry.
2. Tool returns compact JSON to the OpenAI Agent.
3. Agents SDK runs LLM again because `toolUseBehavior = "run_llm_again"`.
4. Agent sees tool output with `citationIndex`, `text`, `url`, `title`, `sourceType`, `airlineName`, `routeScope`.
5. Agent instructions force answer only from tool output.
6. Agent includes citations like `[1]`.

Example final answer style:

```text
For American Airlines from NYC to LAX, use the retrieved American Airlines baggage-policy context for the applicable carry-on and checked-bag details. The answer must cite the retrieved chunks, for example [1] [2].
```

Actual wording depends on retrieved chunks.

## 20. Citation Registry

File: `src/agents/retrieve-context-tool.js`

Why needed:

- Agent may call retrieval multiple times.
- Same chunk can appear again.
- Without registry, `[1]` could change between calls.

Behavior:

- First unique chunk gets citation `1`.
- Next unique chunk gets citation `2`.
- Duplicate chunk keeps original citation.
- Final `answerQuery` returns citations sorted by citation index.

Final API response contains both:

- `citations`: compact metadata for display.
- `chunks`: full evidence chunks for debugging/inspection.

## 21. Logging

File: `src/agents/interaction-logger.js`

Lines `4-5`:

- Chat logs file: `data/logs/chat-interactions.jsonl`.
- Tool logs file: `data/logs/retrieve-context-tool.jsonl`.
- Workflow step logs file: `data/logs/chat-workflow.jsonl`.

Lines `20-25`: `appendJsonl`

- Ensures logs directory exists.
- Appends one JSON object per line.

Lines `31-33`: tool log append.

- Tool executor writes retrieval tool details.

Lines `35-102`: chat interaction log.

- Logs traceId, status, collection, query, answer, citation count, chunk count, tool call count, compact citation metadata, and errors.
- Also logs a compact `chat_log` JSON to console.

## 22. Complete Example Flow

Request:

```http
POST /api/chat
Content-Type: application/json
```

Body:

```json
{
  "query": "What is American Airlines baggage policy from NYC to LAX?"
}
```

Execution:

1. `src/server.js` starts Express using config.
2. `src/api/app.js` builds app and wires KB system.
3. `src/services/kb-system.js` creates OpenAI, Qdrant, RetrievalService, answerQuery.
4. `src/api/routes.js` routes `POST /api/chat` to `handlers.chat`.
5. `handlers.chat` reads body and normalizes query.
6. Empty query check passes.
7. Handler calls `kb.answerQuery({ query })`.
8. `answerQuery` creates traceId.
9. `answerQuery` validates `OPENAI_API_KEY`.
10. `answerQuery` creates or reuses OpenAI client.
11. `answerQuery` creates citation registry.
12. `answerQuery` creates `retrieve_context` tool.
13. `answerQuery` creates OpenAI Agent with tool required.
14. Agent receives current question.
15. Agent must call `retrieve_context`.
16. Tool receives query/topK/filter generated by agent.
17. Tool resolves topK, usually `6`.
18. Tool merges filters, usually inferred only.
19. Tool calls `RetrievalService.retrieve`.
20. Retrieval validates query and OpenAI support.
21. Retrieval detects baggage query.
22. Retrieval lists available baggage-directory airlines from Qdrant.
23. Retrieval matches American Airlines from query.
24. Retrieval enters directory row mode.
25. Directory rows for American Airlines are loaded from Qdrant.
26. Rows are scored by airline, route, facet, and richness.
27. Best row is selected.
28. Because query says baggage policy, linked policy lookup may run.
29. Linked policy vector retrieval runs against official airline policy chunks.
30. HyDE may generate a hypothetical passage for vector search.
31. Embeddings are generated for HyDE/query plans.
32. Qdrant vector query returns candidate chunks.
33. Result lists are fused/reranked.
34. Retrieval returns final hits.
35. Tool registers chunks and assigns citation indices.
36. Tool returns results to agent.
37. Agent runs again with tool output.
38. Agent writes grounded answer with `[1]`, `[2]`.
39. `answerQuery` gets final output and chunks.
40. `answerQuery` logs chat interaction.
41. Handler sends JSON response.

## 23. Success Response Shape

```json
{
  "answer": "Grounded answer with citations like [1] [2].",
  "citations": [
    {
      "citationIndex": 1,
      "url": "https://...",
      "title": "Example title",
      "sectionPath": ["..."],
      "chunkIndex": 0,
      "score": 1.234
    }
  ],
  "chunks": [
    {
      "citationIndex": 1,
      "url": "https://...",
      "title": "Example title",
      "sourceType": "baggage_directory_row",
      "airlineName": "American Airlines",
      "routeScope": "Anywhere to Anywhere",
      "sectionPath": ["..."],
      "text": "Retrieved evidence text...",
      "score": 1.234
    }
  ]
}
```

## 24. No-Chunk Response

If retrieval tool returns zero chunks:

```json
{
  "answer": "I could not find relevant chunks in the indexed URL knowledge base.",
  "citations": [],
  "chunks": []
}
```

This is handled in `src/agents/kb-chat-service.js` lines `89-107`.

## 25. Error Response

If API key missing or Qdrant/OpenAI fails:

1. Error thrown inside service/tool/agent.
2. `asyncHandler` catches and forwards to `errorHandler`.
3. `errorHandler` returns:

```json
{
  "error": "Error message here"
}
```

## 26. Short Mental Model

```text
User
  -> POST /api/chat
  -> Express handler
  -> kb.answerQuery()
  -> OpenAI Agent
  -> retrieve_context tool
  -> RetrievalService.retrieve()
  -> Qdrant + HyDE + embeddings + reranking
  -> tool returns chunks
  -> Agent writes cited answer
  -> API returns { answer, citations, chunks }
```

## 27. What To Check While Debugging

Check config:

- Is `OPENAI_API_KEY` present?
- Is `QDRANT_URL` correct?
- Is `QDRANT_COLLECTION` correct?

Check route:

- Is request going to `POST /api/chat`?
- Is body JSON?
- Is `query` a non-empty string?

Check logs:

- `data/logs/chat-workflow.jsonl`
- `data/logs/retrieve-context-tool.jsonl`
- `data/logs/chat-interactions.jsonl`

Check retrieval trace inside tool logs:

- `tool_input_received`
- `tool_input_resolved`
- `retrieve_started`
- `directory_row_mode_started` or `vector_retrieval_started`
- `directory_rows_scored`
- `build_search_plans_started`
- `build_search_plans_hyde_completed`
- `vector_query_completed`
- `vector_fusion_completed`
- `retrieve_completed`

Common issue:

- If answer says `I could not find relevant chunks`, retrieval returned zero chunks.
- Root cause can be missing Qdrant data, wrong collection, bad airline match, overly narrow filter, or no indexed content for that query.
