import { getJson, postJson, putJson, requestJson } from "./http.js";

function collectionVectorSize(payload) {
  const vectors = payload?.result?.config?.params?.vectors;

  if (!vectors) {
    return null;
  }

  if (typeof vectors.size === "number") {
    return vectors.size;
  }

  if (typeof vectors === "object") {
    const firstVector = Object.values(vectors)[0];
    return firstVector?.size || null;
  }

  return null;
}

function buildPayloadFilter(filter = {}) {
  const must = [];

  if (filter.url) {
    must.push({
      key: "url",
      match: { value: filter.url },
    });
  }

  if (filter.domain) {
    must.push({
      key: "domain",
      match: { value: filter.domain },
    });
  }

  if (filter.sourceType) {
    must.push({
      key: "sourceType",
      match: { value: filter.sourceType },
    });
  }

  if (filter.airline) {
    must.push({
      key: "airlineName",
      match: { value: filter.airline },
    });
  }

  if (filter.rowId) {
    must.push({
      key: "rowId",
      match: { value: filter.rowId },
    });
  }

  if (typeof filter.retrievalAllowed === "boolean") {
    must.push({
      key: "retrievalAllowed",
      match: { value: filter.retrievalAllowed },
    });
  }

  if (!must.length) {
    return undefined;
  }

  return { must };
}

class QdrantService {
  constructor(config) {
    this.baseUrl = config.qdrantUrl.replace(/\/+$/u, "");
    this.collection = config.qdrantCollection;
    this.headers = config.qdrantApiKey
      ? { "api-key": config.qdrantApiKey }
      : {};
  }

  async getCollectionInfo() {
    try {
      return await getJson(
        `${this.baseUrl}/collections/${this.collection}`,
        this.headers,
      );
    } catch (error) {
      if (error.statusCode === 404) {
        return null;
      }

      throw error;
    }
  }

  async deleteCollection() {
    try {
      return await requestJson(
        `${this.baseUrl}/collections/${this.collection}`,
        {
          method: "DELETE",
          headers: this.headers,
        },
      );
    } catch (error) {
      if (error.statusCode === 404) {
        return null;
      }

      throw error;
    }
  }

  async ensureCollection(vectorSize) {
    const current = await this.getCollectionInfo();

    if (!current) {
      await putJson(
        `${this.baseUrl}/collections/${this.collection}`,
        {
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
        },
        this.headers,
      );
      return {
        collection: this.collection,
        vectorSize,
        created: true,
      };
    }

    const existingSize = collectionVectorSize(current);
    if (existingSize && existingSize !== vectorSize) {
      throw new Error(
        `Qdrant collection ${this.collection} already exists with vector size ${existingSize}, expected ${vectorSize}.`,
      );
    }

    return {
      collection: this.collection,
      vectorSize: existingSize || vectorSize,
      created: false,
    };
  }

  async deleteDocument(docId) {
    let response;

    try {
      response = await postJson(
        `${this.baseUrl}/collections/${this.collection}/points/delete?wait=true`,
        {
          filter: {
            must: [
              {
                key: "docId",
                match: { value: docId },
              },
            ],
          },
        },
        this.headers,
      );
    } catch (error) {
      if (error.statusCode === 404) {
        return {
          collection: this.collection,
          docId,
          status: "missing_collection",
          operationId: null,
        };
      }

      throw error;
    }

    return {
      collection: this.collection,
      docId,
      status: response?.status || "unknown",
      operationId: response?.result?.operation_id || null,
    };
  }

  async upsertRecords(records, vectors) {
    if (records.length !== vectors.length) {
      throw new Error("Record count and embedding count do not match.");
    }

    const points = records.map((record, index) => ({
      id: record.id,
      vector: vectors[index],
      payload: {
        docId: record.docId,
        url: record.url,
        canonicalUrl: record.canonicalUrl || record.url,
        redirectedUrl: record.redirectedUrl || null,
        domain: record.domain,
        title: record.title,
        chunkIndex: record.chunkIndex ?? record.sectionIndex ?? 0,
        sectionId: record.sectionId || record.id,
        sectionIndex: record.sectionIndex ?? record.chunkIndex ?? 0,
        partIndex: record.partIndex ?? 0,
        sectionTitle: record.sectionTitle || null,
        sectionPath: record.sectionPath || [],
        sectionSlug: record.sectionSlug || null,
        anchorText: record.anchorText || null,
        text: record.text,
        fetchedAt: record.fetchedAt,
        contentHash: record.contentHash,
        textHash: record.textHash,
        sourceType: record.sourceType || null,
        authority: record.authority || null,
        qualityStatus: record.qualityStatus || null,
        retrievalAllowed: Boolean(record.retrievalAllowed),
        airlineName: record.airlineName || null,
        airlineSlug: record.airlineSlug || null,
        rowId: record.rowId || null,
        routeScope: record.routeScope || null,
        rowText: record.rowText || null,
        embeddingText: record.embeddingText || null,
        carryOnText: record.carryOnText || null,
        carryOnCost: record.carryOnCost || null,
        carryOnWeight: record.carryOnWeight || null,
        carryOnSize: record.carryOnSize || null,
        carryOnNotes: record.carryOnNotes || null,
        firstBagUrl: record.firstBagUrl || null,
        secondBagUrl: record.secondBagUrl || null,
        additionalPolicyUrl: record.additionalPolicyUrl || null,
      },
    }));

    const response = await putJson(
      `${this.baseUrl}/collections/${this.collection}/points?wait=true`,
      { points },
      this.headers,
    );

    return {
      collection: this.collection,
      pointCount: points.length,
      status: response?.status || "unknown",
      operationId: response?.result?.operation_id || null,
    };
  }

  async upsertChunks(chunks, vectors) {
    return this.upsertRecords(chunks, vectors);
  }

  async scrollPoints({ filter, limit = 256, withPayload = true, withVector = false }) {
    const points = [];
    let offset = null;

    while (true) {
      let response;

      try {
        response = await postJson(
          `${this.baseUrl}/collections/${this.collection}/points/scroll`,
          {
            limit,
            with_payload: withPayload,
            with_vector: withVector,
            filter: buildPayloadFilter(filter),
            offset,
          },
          this.headers,
        );
      } catch (error) {
        if (error.statusCode === 404) {
          return [];
        }

        throw error;
      }

      const batch = response?.result?.points || [];
      points.push(...batch);

      offset = response?.result?.next_page_offset || null;
      if (!offset || !batch.length) {
        break;
      }
    }

    return points;
  }

  async listAirlines({ sourceType = "airline_policy" } = {}) {
    const points = await this.scrollPoints({
      filter: {
        sourceType,
        retrievalAllowed: true,
      },
      limit: 512,
      withPayload: true,
      withVector: false,
    });
    const airlines = new Map();

    for (const point of points) {
      const airlineName = point.payload?.airlineName;
      const airlineSlug = point.payload?.airlineSlug;
      if (!airlineName) {
        continue;
      }

      const key = `${airlineName}::${airlineSlug || ""}`;
      if (!airlines.has(key)) {
        airlines.set(key, {
          airlineName,
          airlineSlug: airlineSlug || null,
        });
      }
    }

    return [...airlines.values()].sort((left, right) =>
      left.airlineName.localeCompare(right.airlineName),
    );
  }

  async listDirectoryRows({ airline } = {}) {
    const points = await this.scrollPoints({
      filter: {
        sourceType: "baggage_directory_row",
        airline,
        retrievalAllowed: true,
      },
      limit: 1024,
      withPayload: true,
      withVector: false,
    });

    return points.map((point) => ({
      id: point.id,
      score: point.score || 0,
      ...point.payload,
    }));
  }

  async query({ vector, topK, filter }) {
    let response;

    try {
      response = await postJson(
        `${this.baseUrl}/collections/${this.collection}/points/query`,
        {
          query: vector,
          limit: topK,
          with_payload: true,
          with_vector: false,
          filter: buildPayloadFilter(filter),
        },
        this.headers,
      );
    } catch (error) {
      if (error.statusCode === 404) {
        return [];
      }

      throw error;
    }

    const hits = response?.result?.points || response?.result || [];

    return hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      ...hit.payload,
    }));
  }
}

export { buildPayloadFilter, QdrantService };
