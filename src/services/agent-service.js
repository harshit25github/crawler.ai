export class AgentService {
  constructor({ openAiService, retrieveChunksTool }) {
    this.openAiService = openAiService;
    this.retrieveChunksTool = retrieveChunksTool;
  }

  async answerQuery({ query, topK, filter, history = [] }) {
    const chunks = await this.retrieveChunksTool.execute({
      query,
      topK,
      filter,
    });

    if (!chunks.length) {
      return {
        answer: "I could not find relevant chunks in the indexed URL knowledge base.",
        citations: [],
        chunks: [],
      };
    }

    const answer = await this.openAiService.generateGroundedAnswer({
      query,
      history,
      chunks,
    });

    return {
      answer,
      citations: chunks.map((chunk) => ({
        citationIndex: chunk.citationIndex,
        url: chunk.url,
        title: chunk.title,
        sectionPath: chunk.sectionPath,
        chunkIndex: chunk.chunkIndex,
        score: chunk.score,
      })),
      chunks,
    };
  }
}
