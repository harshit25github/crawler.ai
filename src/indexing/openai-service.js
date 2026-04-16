import OpenAI from "openai";
import { Agent, run, setDefaultOpenAIClient, setOpenAIAPI } from "@openai/agents";
import { postJson } from "./http.js";

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

class OpenAIService {
  constructor(config) {
    this.apiKey = config.openAiApiKey;
    this.baseUrl = config.openAiBaseUrl.replace(/\/+$/u, "");
    this.embeddingModel = config.openAiEmbeddingModel;
    this.chatModel = config.openAiChatModel;
    this.sdkClient = null;
    this.hydeAgent = null;
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

  hasEmbeddingSupport() {
    return Boolean(this.apiKey);
  }

  hasChatSupport() {
    return Boolean(this.apiKey);
  }

  getEmbeddingConfig() {
    return {
      baseUrl: this.baseUrl,
      model: this.embeddingModel,
    };
  }

  getSdkClient() {
    if (!this.sdkClient) {
      this.sdkClient = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
        timeout: 120_000,
      });
    }

    return this.sdkClient;
  }

  getHydeAgent() {
    if (!this.hydeAgent) {
      this.hydeAgent = new Agent({
        name: "HyDE Passage Generator",
        model: this.chatModel,
        instructions:
          "Write one concise hypothetical passage that could plausibly appear in the source document needed to answer the user's question. Use source-like language and concrete details. Do not mention that the passage is hypothetical. Do not answer conversationally.",
        modelSettings: {
          temperature: 0.2,
        },
      });
    }

    return this.hydeAgent;
  }

  async generateHypotheticalDocument({ query, filter = {} }) {
    const scope = [
      filter.sourceType ? `Source type: ${filter.sourceType}` : null,
      filter.domain ? `Domain: ${filter.domain}` : null,
      filter.url ? `URL: ${filter.url}` : null,
      filter.airline ? `Airline: ${filter.airline}` : null,
      filter.facet ? `Facet: ${filter.facet}` : null,
      filter.privacyAspect ? `Privacy aspect: ${filter.privacyAspect}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    setOpenAIAPI("chat_completions");
    setDefaultOpenAIClient(this.getSdkClient());

    const result = await run(
      this.getHydeAgent(),
      [
        scope || "Source type: general web page",
        `Question: ${query}`,
        "Write one short passage that looks like grounded source content.",
      ].join("\n"),
      { maxTurns: 1 },
    );

    const content = String(result.finalOutput || "").trim();

    if (!content) {
      throw new Error("OpenAI HyDE generation response was empty.");
    }

    return content;
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
        const fact = chunk.matchedFact
          ? [
              `Fact facet: ${chunk.matchedFact.facet}`,
              `Fact value: ${chunk.matchedFact.valueText}`,
            ].join("\n")
          : null;

        return [
          `[${index + 1}]`,
          `URL: ${chunk.url}`,
          `Title: ${chunk.title}`,
          `Source Type: ${chunk.sourceType || "unknown"}`,
          `Airline: ${chunk.airlineName || "n/a"}`,
          `Route Scope: ${chunk.routeScope || "n/a"}`,
          `Section: ${section}`,
          `Chunk: ${chunk.chunkIndex}`,
          fact,
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

export { OpenAIService };
