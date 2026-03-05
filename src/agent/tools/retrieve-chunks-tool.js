export function createRetrieveChunksTool(retrievalService) {
  return {
    name: "retrieve_chunks",
    description:
      "Retrieve the most relevant knowledge base chunks from Qdrant for a user question.",
    async execute(input) {
      return retrievalService.retrieve(input.query, {
        topK: input.topK,
        filter: input.filter,
      });
    },
  };
}
