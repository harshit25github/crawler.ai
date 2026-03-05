import { getJson, postJson, putJson } from "../lib/http.js";

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

export function buildPayloadFilter(filter = {}) {
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

  if (!must.length) {
    return undefined;
  }

  return { must };
}

export class QdrantService {
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
    const response = await postJson(
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

    return {
      collection: this.collection,
      docId,
      status: response?.status || "unknown",
      operationId: response?.result?.operation_id || null,
    };
  }

  async upsertChunks(chunks, vectors) {
    if (chunks.length !== vectors.length) {
      throw new Error("Chunk count and embedding count do not match.");
    }

    const points = chunks.map((chunk, index) => ({
      id: chunk.id,
      vector: vectors[index],
      payload: {
        docId: chunk.docId,
        url: chunk.url,
        domain: chunk.domain,
        title: chunk.title,
        chunkIndex: chunk.chunkIndex,
        sectionPath: chunk.sectionPath,
        text: chunk.text,
        fetchedAt: chunk.fetchedAt,
        contentHash: chunk.contentHash,
        textHash: chunk.textHash,
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

  async query({ vector, topK, filter }) {
    const response = await postJson(
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

    const hits = response?.result?.points || response?.result || [];

    return hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      ...hit.payload,
    }));
  }
}
