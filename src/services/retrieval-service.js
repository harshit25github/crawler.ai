export class RetrievalService {
  constructor({ config, openAiService, qdrantService }) {
    this.config = config;
    this.openAiService = openAiService;
    this.qdrantService = qdrantService;
  }

  async retrieve(query, options = {}) {
    if (!query?.trim()) {
      throw new Error("A non-empty query is required.");
    }

    const [vector] = await this.openAiService.createEmbeddings([query]);
    const topK = options.topK || this.config.defaultTopK;
    const hits = await this.qdrantService.query({
      vector,
      topK,
      filter: options.filter,
    });

    return hits.map((hit, index) => ({
      citationIndex: index + 1,
      ...hit,
    }));
  }
}
