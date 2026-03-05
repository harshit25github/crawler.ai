import { postJson } from "../lib/http.js";

function requiredApiKey(apiKey) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for embeddings and chat.");
  }

  return apiKey;
}

function buildHeaders(apiKey) {
  return {
    authorization: `Bearer ${requiredApiKey(apiKey)}`,
  };
}

export class OpenAIService {
  constructor(config) {
    this.apiKey = config.openAiApiKey;
    this.baseUrl = config.openAiBaseUrl.replace(/\/+$/u, "");
    this.embeddingModel = config.openAiEmbeddingModel;
    this.chatModel = config.openAiChatModel;
  }

  async createEmbeddings(inputs) {
    const response = await postJson(
      `${this.baseUrl}/embeddings`,
      {
        model: this.embeddingModel,
        input: inputs,
      },
      buildHeaders(this.apiKey),
    );

    const vectors = response?.data?.map((item) => item.embedding);

    if (!vectors?.length) {
      throw new Error("OpenAI embeddings response was empty.");
    }

    return vectors;
  }

  getEmbeddingConfig() {
    return {
      baseUrl: this.baseUrl,
      model: this.embeddingModel,
    };
  }

  async generateGroundedAnswer({ query, history = [], chunks }) {
    if (!chunks.length) {
      return "I could not find any relevant indexed content for that question.";
    }

    const formattedContext = chunks
      .map((chunk, index) => {
        const section = chunk.sectionPath?.length
          ? chunk.sectionPath.join(" > ")
          : "General";

        return [
          `[${index + 1}]`,
          `URL: ${chunk.url}`,
          `Title: ${chunk.title}`,
          `Section: ${section}`,
          `Chunk: ${chunk.chunkIndex}`,
          `Text: ${chunk.text}`,
        ].join("\n");
      })
      .join("\n\n");

    const sanitizedHistory = history
      .filter(
        (message) =>
          message &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string" &&
          message.content.trim(),
      )
      .slice(-8)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const response = await postJson(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.chatModel,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You answer only from the retrieved context. If the answer is not in the context, say you do not know. Cite every material claim with chunk markers like [1] or [2]. Do not invent sources.",
          },
          ...sanitizedHistory,
          {
            role: "user",
            content: [
              "Retrieved context:",
              formattedContext,
              "",
              `Question: ${query}`,
              "Answer with concise citations tied to the chunk numbers.",
            ].join("\n"),
          },
        ],
      },
      buildHeaders(this.apiKey),
    );

    const content = response?.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error("OpenAI chat response was empty.");
    }

    return content;
  }
}
