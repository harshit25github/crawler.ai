import {
  detectFacet,
  detectPrivacyAspects,
  detectRouteScopeHints,
  isComparisonQuery,
} from "./query-routing.js";
import {
  PRIVACY_ASPECT_LABELS,
  PRIVACY_TOPIC_BY_ID,
  uniqueBy,
  withCitations,
  hitKey,
  traceStep,
  summarizeTraceHit,
  summarizeTraceHits,
  normalizeHit,
  routeAirlines,
  buildVectorFilter,
  buildAirlineTargets,
  mergeSearchVariants,
  shouldUseDirectoryRowMode,
  detectDirectoryFieldIntent,
  detectLinkedPolicyFacetRequests,
  buildLinkedPolicyQueries,
  pickBestLinkedPolicyHit,
  buildUrlVariants,
  buildRouteProfile,
  structuredRowDetailRichness,
  scoreDirectoryRow,
  compareDirectoryRowCandidates,
  formatStructuredRowHit,
  selectRowHitsForAirline,
  shouldKeepDirectoryRowFirst,
  detectPrivacyTopics,
  matchesPrivacyTopic,
  scorePrivacyTopicCandidate,
  fuseRankedLists,
} from "./helpers.js";

export class RetrievalService {
  constructor({ config, openAiService, qdrantService }) {
    this.config = config;
    this.openAiService = openAiService;
    this.qdrantService = qdrantService;
  }

  async buildSearchPlans({ query, filter, routedAirlines = [], trace = null }) {
    const plans = [
      {
        label: "query",
        text: query,
        weight: 1,
      },
    ];

    traceStep(trace, "build_search_plans_started", {
      query,
      filter,
      routedAirlines: routedAirlines.map((entry) => entry.airlineName || null),
    });

    if (routedAirlines.length) {
      for (const airline of routedAirlines) {
        const airlineName = airline.airlineName;
        if (!airlineName) {
          continue;
        }

        plans.push({
          label: `airline:${airlineName}`,
          text: [airlineName, filter.facet || "", query].filter(Boolean).join("\n"),
          weight: 1.1,
        });
      }
    }

    const hydeRequests = [
      {
        label: "hyde",
        weight: 1.25,
        filter,
        query,
      },
    ];
    const privacyAspects =
      filter.sourceType === "privacy_policy"
        ? detectPrivacyAspects(query)
        : [];

    traceStep(trace, "build_search_plans_base", {
      basePlans: plans.map((plan) => ({
        label: plan.label,
        weight: plan.weight,
      })),
      privacyAspects,
      hydeRequests: hydeRequests.map((request) => ({
        label: request.label,
        weight: request.weight,
      })),
    });

    if (privacyAspects.length > 1) {
      for (const aspect of privacyAspects) {
        hydeRequests.push({
          label: `hyde:${aspect}`,
          weight: 1.12,
          filter: {
            ...filter,
            privacyAspect: aspect,
          },
          query: [
            query,
            `Focus specifically on ${PRIVACY_ASPECT_LABELS[aspect] || aspect}.`,
          ].join("\n"),
        });
      }
    }

    const hypotheticalPassages = await Promise.all(
      hydeRequests.map((request) =>
        this.openAiService.generateHypotheticalDocument({
          query: request.query,
          filter: request.filter,
        }),
      ),
    );

    hypotheticalPassages.forEach((hypothetical, index) => {
      if (!hypothetical) {
        return;
      }

      const request = hydeRequests[index];
      plans.unshift({
        label: request.label,
        text: hypothetical,
        weight: request.weight,
      });
    });

    traceStep(trace, "build_search_plans_hyde_completed", {
      generatedPassages: hydeRequests.map((request, index) => ({
        label: request.label,
        generated: Boolean(hypotheticalPassages[index]),
        length: hypotheticalPassages[index]?.length || 0,
      })),
      finalPlans: plans.map((plan) => ({
        label: plan.label,
        weight: plan.weight,
      })),
    });

    const vectors = await this.openAiService.createEmbeddings(
      plans.map((plan) => plan.text),
    );

    return plans.map((plan, index) => ({
      ...plan,
      vector: vectors[index],
    }));
  }

  async retrieveVectorHits(query, { topK, filter, routedAirlines = [], trace = null }) {
    const searchPlans = await this.buildSearchPlans({
      query,
      filter,
      routedAirlines,
      trace,
    });
    const airlineTargets = buildAirlineTargets(filter, routedAirlines);
    const perQueryTopK =
      airlineTargets.length > 1
        ? Math.max(3, Math.ceil(topK / airlineTargets.length) + 1)
        : topK;
    const resultLists = [];

    traceStep(trace, "vector_retrieval_started", {
      query,
      topK,
      perQueryTopK,
      filter,
      airlineTargets,
      searchPlans: searchPlans.map((plan) => ({
        label: plan.label,
        weight: plan.weight,
      })),
    });

    for (const plan of searchPlans) {
      for (const airline of airlineTargets) {
        const hits = await this.qdrantService.query({
          vector: plan.vector,
          topK: perQueryTopK,
          filter: buildVectorFilter(filter, airline),
        });

        resultLists.push({
          label: plan.label,
          weight: plan.weight,
          hits: hits.map((hit) => normalizeHit(hit, plan.label)),
        });

        traceStep(trace, "vector_query_completed", {
          planLabel: plan.label,
          planWeight: plan.weight,
          airlineTarget: airline,
          filter: buildVectorFilter(filter, airline),
          hitCount: hits.length,
          topHits: summarizeTraceHits(hits),
        });
      }
    }

    const fusedHits = fuseRankedLists({
      lists: resultLists,
      topK,
      query,
      routedAirlines,
    });

    traceStep(trace, "vector_fusion_completed", {
      listCount: resultLists.length,
      topK,
      fusedHitCount: fusedHits.length,
      fusedTopHits: summarizeTraceHits(fusedHits),
    });

    return fusedHits;
  }

  async retrieveDirectoryRows({
    query,
    topK,
    filter,
    facet,
    routedAirlines,
    trace = null,
  }) {
    const comparison = isComparisonQuery(query);
    const routeHints = detectRouteScopeHints(query);
    const routeIntent = buildRouteProfile(query);
    const fieldIntent = detectDirectoryFieldIntent(query);
    const airlineTargets = buildAirlineTargets(filter, routedAirlines).filter(Boolean);
    const exactHits = [];

    traceStep(trace, "directory_row_mode_started", {
      query,
      topK,
      filter,
      facet,
      comparison,
      routeHints,
      routeIntent,
      fieldIntent,
      airlineTargets,
    });

    for (const airline of airlineTargets) {
      const rows = await this.qdrantService.listDirectoryRows({
        airline,
      });
      const scored = rows
        .map((row) => ({
          row,
          score: scoreDirectoryRow({
            row,
            query,
            facet,
            fieldIntent,
            routeIntent,
            requestedAirline: airline,
          }),
          detailRichness: structuredRowDetailRichness(row),
        }))
        .filter((entry) => entry.score > 0)
        .sort(compareDirectoryRowCandidates)
        .map((entry) => formatStructuredRowHit(entry.row, entry.score));

      traceStep(trace, "directory_rows_scored", {
        airline,
        fetchedRowCount: rows.length,
        positiveRowCount: scored.length,
        topRows: scored.slice(0, 3).map((entry) => ({
          rowId: entry.rowId || null,
          airlineName: entry.airlineName || null,
          routeScope: entry.routeScope || null,
          score: entry.score,
          carryOnCost: entry.carryOnCost || null,
          carryOnWeight: entry.carryOnWeight || null,
          carryOnSize: entry.carryOnSize || null,
        })),
      });

      exactHits.push(
        ...selectRowHitsForAirline(scored, {
          allowAlternateRoute:
            !comparison &&
            !routeHints.length &&
            (airlineTargets.length <= 1),
        }),
      );
    }

    const uniqueExactHits = uniqueBy(
      exactHits,
      (hit) => hit.rowId || hit.sectionId || hit.id,
    ).slice(0, topK);
    const exactEnough =
      uniqueExactHits.length >=
      (comparison ? Math.max(2, airlineTargets.length) : 1);
    const expandedExactHits = await this.expandDirectoryRowsWithLinkedPolicy({
      query,
      topK,
      facet,
      fieldIntent,
      rowHits: uniqueExactHits,
      trace,
    });

    traceStep(trace, "directory_exact_hits_evaluated", {
      exactHitCount: uniqueExactHits.length,
      expandedExactHitCount: expandedExactHits.length,
      exactEnough,
      topExactHits: summarizeTraceHits(expandedExactHits),
    });

    if (exactEnough) {
      return withCitations(expandedExactHits);
    }

    const vectorRowHits = await this.retrieveVectorHits(query, {
      topK,
      filter: {
        ...filter,
        sourceType: "baggage_directory_row",
        facet,
      },
      routedAirlines,
      trace,
    });
    const mergedRowHits = uniqueBy(
      [...uniqueExactHits, ...vectorRowHits],
      (hit) => hit.rowId || hit.sectionId || hit.id,
    ).slice(0, topK);
    const expandedMergedRowHits = await this.expandDirectoryRowsWithLinkedPolicy({
      query,
      topK,
      facet,
      fieldIntent,
      rowHits: mergedRowHits,
      trace,
    });

    traceStep(trace, "directory_vector_row_fallback_completed", {
      vectorRowHitCount: vectorRowHits.length,
      mergedRowHitCount: mergedRowHits.length,
      expandedMergedRowHitCount: expandedMergedRowHits.length,
      topMergedHits: summarizeTraceHits(expandedMergedRowHits),
    });

    if (
      expandedMergedRowHits.length >=
      (comparison ? Math.max(2, airlineTargets.length) : 1)
    ) {
      return withCitations(expandedMergedRowHits);
    }

    const fallbackHits = await this.retrieveVectorHits(query, {
      topK,
      filter: {
        ...filter,
        sourceType: "baggage_directory",
        facet,
      },
      routedAirlines: [],
      trace,
    });

    traceStep(trace, "directory_page_fallback_completed", {
      fallbackHitCount: fallbackHits.length,
      topFallbackHits: summarizeTraceHits(fallbackHits),
    });

    return withCitations(
      uniqueBy(
        [...expandedMergedRowHits, ...fallbackHits],
        (hit) => hitKey(hit),
      ).slice(0, topK),
    );
  }

  async fetchLinkedPolicyHit({ query, row, request, trace = null }) {
    const focusedQuery = buildLinkedPolicyQueries(query, row, request);

    traceStep(trace, "linked_policy_lookup_started", {
      airlineName: row.airlineName || null,
      routeScope: row.routeScope || null,
      facet: request.facet,
      urlField: request.urlField,
      originalUrl: row[request.urlField] || null,
      focusedQuery,
    });

    for (const url of buildUrlVariants(row[request.urlField])) {
      const linkedHits = await this.retrieveVectorHits(focusedQuery, {
        topK: 5,
        filter: {
          sourceType: "airline_policy",
          facet: request.facet,
          url,
        },
        routedAirlines: [],
        trace,
      });

      if (linkedHits.length) {
        const selectedHit = pickBestLinkedPolicyHit(linkedHits, request);
        traceStep(trace, "linked_policy_lookup_url_match", {
          airlineName: row.airlineName || null,
          facet: request.facet,
          matchedUrl: url,
          candidateCount: linkedHits.length,
          hit: summarizeTraceHit(selectedHit),
        });
        return mergeSearchVariants(
          {
            ...selectedHit,
            linkedPolicyFacet: request.facet,
            linkedPolicyUrl: row[request.urlField] || null,
            linkedFromRowId: row.rowId || null,
          },
          [`linked-policy:${request.facet}`],
        );
      }
    }

    if (!row.airlineName) {
      return null;
    }

    const fallbackHits = await this.retrieveVectorHits(focusedQuery, {
      topK: 5,
      filter: {
        sourceType: "airline_policy",
        facet: request.facet,
        airline: row.airlineName,
      },
      routedAirlines: [],
      trace,
    });

    if (!fallbackHits.length) {
      traceStep(trace, "linked_policy_lookup_missed", {
        airlineName: row.airlineName || null,
        facet: request.facet,
      });
      return null;
    }

    const selectedFallbackHit = pickBestLinkedPolicyHit(fallbackHits, request);
    traceStep(trace, "linked_policy_lookup_airline_fallback", {
      airlineName: row.airlineName || null,
      facet: request.facet,
      candidateCount: fallbackHits.length,
      hit: summarizeTraceHit(selectedFallbackHit),
    });

    return mergeSearchVariants(
      {
        ...selectedFallbackHit,
        linkedPolicyFacet: request.facet,
        linkedPolicyUrl: row[request.urlField] || null,
        linkedFromRowId: row.rowId || null,
      },
      [`linked-policy:${request.facet}`],
    );
  }

  async expandDirectoryRowsWithLinkedPolicy({
    query,
    topK,
    facet,
    fieldIntent,
    rowHits,
    trace = null,
  }) {
    const requests = detectLinkedPolicyFacetRequests(query, facet);
    traceStep(trace, "directory_linked_policy_requests_detected", {
      facet,
      fieldIntent,
      requestCount: requests.length,
      requests: requests.map((request) => ({
        facet: request.facet,
        label: request.label,
        urlField: request.urlField,
      })),
      rowHitCount: rowHits.length,
    });

    if (!requests.length || !rowHits.length) {
      return rowHits;
    }

    const linkedPolicyHits = [];

    for (const row of rowHits.filter((hit) => hit.sourceType === "baggage_directory_row")) {
      for (const request of requests) {
        const hit = await this.fetchLinkedPolicyHit({
          query,
          row,
          request,
          trace,
        });

        if (hit) {
          linkedPolicyHits.push(hit);
        }
      }
    }

    if (!linkedPolicyHits.length) {
      return rowHits;
    }

    const ordered = shouldKeepDirectoryRowFirst({ query, facet, fieldIntent })
      ? [...rowHits, ...linkedPolicyHits]
      : [...linkedPolicyHits, ...rowHits];

    traceStep(trace, "directory_linked_policy_expanded", {
      keepDirectoryRowFirst: shouldKeepDirectoryRowFirst({
        query,
        facet,
        fieldIntent,
      }),
      linkedPolicyHitCount: linkedPolicyHits.length,
      linkedPolicyHits: summarizeTraceHits(linkedPolicyHits),
      orderedHitCount: ordered.length,
    });

    return uniqueBy(ordered, (hit) => hitKey(hit)).slice(0, topK);
  }

  async ensurePrivacyTopicCoverage({ query, topK, filter, hits, trace = null }) {
    const topics = detectPrivacyTopics(query)
      .map((topic) => PRIVACY_TOPIC_BY_ID.get(topic))
      .filter(Boolean);

    traceStep(trace, "privacy_topic_coverage_started", {
      query,
      topK,
      topics: topics.map((topic) => topic.topic),
      initialHitCount: hits.length,
      initialTopHits: summarizeTraceHits(hits),
    });

    if (topics.length <= 1 || typeof this.qdrantService.scrollPoints !== "function") {
      return hits;
    }

    const points = await this.qdrantService.scrollPoints({
      filter: {
        ...filter,
        sourceType: "privacy_policy",
        retrievalAllowed: true,
      },
      limit: 256,
      withPayload: true,
      withVector: false,
    });

    if (!points.length) {
      return hits;
    }

    const candidates = points.map((point) => ({
      id: point.id,
      score: point.score || 0,
      ...point.payload,
      sectionId: point.payload?.sectionId || point.id,
      retrievalStrategy: "hyde",
      searchVariants: ["hyde", "privacy-topic"],
    }));
    const selected = [];
    const used = new Set();

    for (const definition of topics) {
      const existing = hits.find(
        (hit) => !used.has(hitKey(hit)) && matchesPrivacyTopic(hit, definition),
      );

      if (existing) {
        traceStep(trace, "privacy_topic_existing_hit_used", {
          topic: definition.topic,
          hit: summarizeTraceHit(existing),
        });
        selected.push(
          mergeSearchVariants(existing, [`privacy-topic:${definition.topic}`]),
        );
        used.add(hitKey(existing));
        continue;
      }

      const candidate = candidates
        .map((entry) => ({
          entry,
          score: scorePrivacyTopicCandidate({
            candidate: entry,
            definition,
            query,
          }),
        }))
        .filter(({ score, entry }) => score > 0 && !used.has(hitKey(entry)))
        .sort((left, right) => right.score - left.score)[0];

      if (!candidate) {
        traceStep(trace, "privacy_topic_candidate_missing", {
          topic: definition.topic,
        });
        continue;
      }

      traceStep(trace, "privacy_topic_candidate_selected", {
        topic: definition.topic,
        candidate: summarizeTraceHit(candidate.entry),
        candidateScore: candidate.score,
      });
      selected.push({
        ...candidate.entry,
        score:
          candidate.entry.score ||
          Math.max(0.0001, (hits.at(-1)?.score || 0.01) - selected.length * 0.0001),
        searchVariants: ["hyde", `privacy-topic:${definition.topic}`],
      });
      used.add(hitKey(candidate.entry));
    }

    for (const hit of hits) {
      if (used.has(hitKey(hit))) {
        continue;
      }

      selected.push(hit);
    }

    const finalHits = uniqueBy(selected, (hit) => hitKey(hit)).slice(0, topK);
    traceStep(trace, "privacy_topic_coverage_completed", {
      finalHitCount: finalHits.length,
      finalTopHits: summarizeTraceHits(finalHits),
    });
    return finalHits;
  }

  async retrieve(query, options = {}) {
    if (!query?.trim()) {
      throw new Error("A non-empty query is required.");
    }

    if (!this.openAiService.hasEmbeddingSupport()) {
      throw new Error(
        "Vector retrieval requires OPENAI_API_KEY to generate embeddings.",
      );
    }

    if (!this.openAiService.hasChatSupport()) {
      throw new Error(
        "HyDE retrieval requires OPENAI_API_KEY to generate hypothetical passages.",
      );
    }

    const topK = options.topK || this.config.defaultTopK;
    const filter = options.filter || {};
    const trace = Array.isArray(options.trace) ? options.trace : null;
    const facet = filter.facet || detectFacet(query);
    const directoryMode = shouldUseDirectoryRowMode(query, filter);
    const airlineSourceType =
      directoryMode || filter.sourceType === "baggage_directory_row"
        ? "baggage_directory_row"
        : "airline_policy";
    const availableAirlines =
      directoryMode ||
      filter.sourceType === "baggage_directory_row" ||
      filter.sourceType === "airline_policy" ||
      filter.airline
        ? await this.qdrantService.listAirlines({
            sourceType: airlineSourceType,
          })
        : [];
    const routedAirlines = routeAirlines(query, availableAirlines, filter);

    traceStep(trace, "retrieve_started", {
      query,
      topK,
      filter,
      facet,
      directoryMode,
      airlineSourceType,
      availableAirlineCount: availableAirlines.length,
      routedAirlines: routedAirlines.map((entry) => entry.airlineName || null),
    });

    if (filter.airline && availableAirlines.length && !routedAirlines.length) {
      traceStep(trace, "retrieve_no_airline_match", {
        requestedAirline: filter.airline,
      });
      return [];
    }

    if (directoryMode) {
      const directoryHits = await this.retrieveDirectoryRows({
        query,
        topK,
        filter,
        facet,
        routedAirlines,
        trace,
      });
      traceStep(trace, "retrieve_completed", {
        branch: "directory",
        resultCount: directoryHits.length,
        topHits: summarizeTraceHits(directoryHits),
      });
      return directoryHits;
    }

    const hits = await this.retrieveVectorHits(query, {
      topK,
      filter: {
        ...filter,
        facet,
      },
      routedAirlines,
      trace,
    });
    const finalHits =
      filter.sourceType === "privacy_policy"
        ? await this.ensurePrivacyTopicCoverage({
            query,
            topK,
            filter,
            hits,
            trace,
          })
        : hits;

    const citedHits = withCitations(finalHits);
    traceStep(trace, "retrieve_completed", {
      branch: "vector",
      resultCount: citedHits.length,
      topHits: summarizeTraceHits(citedHits),
    });
    return citedHits;
  }
}
