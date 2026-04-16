import OpenAI from "openai";
import {
  run,
  setDefaultOpenAIClient,
  setOpenAIAPI,
} from "@openai/agents";
import { createChatAgent, buildAgentConversationInput } from "./chat-agent.js";
import {
  createCitationRegistry,
  createRetrieveContextTool,
  MAX_AGENT_TOOL_TOP_K,
} from "./retrieve-context-tool.js";
import {
  logChatInteraction,
  logChatWorkflowStep,
} from "./interaction-logger.js";

function buildTraceId() {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeHistory(history = []) {
  return history
    .filter(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim(),
    )
    .slice(-8);
}

function previewText(value, maxLength = 240) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function createAnswerQuery({ config, retrievalService }) {
  let openAiClient = null;

  return async function answerQuery({
    query,
    topK,
    filter,
    history = [],
    requestSource = "unknown",
    debugContext = null,
  }) {
    const traceId = buildTraceId();
    const toolTraceCollector = [];

    try {
      await logChatWorkflowStep({
        config,
        traceId,
        stage: "answer_query_started",
        query,
        data: {
          requestSource,
          hasTopK: topK !== undefined,
          hasFilter: Boolean(filter && Object.keys(filter).length),
          filterKeys: filter ? Object.keys(filter) : [],
          incomingHistoryCount: Array.isArray(history) ? history.length : 0,
          hasDebugContext: Boolean(debugContext),
          openAiChatModel: config.openAiChatModel,
          openAiEmbeddingModel: config.openAiEmbeddingModel,
          qdrantCollection: config.qdrantCollection,
          defaultTopK: config.defaultTopK,
          openAiConfigured: Boolean(config.openAiApiKey),
        },
      });

      if (!config.openAiApiKey) {
        throw new Error("OPENAI_API_KEY is required for agent answers.");
      }

      const reusedOpenAiClient = Boolean(openAiClient);
      if (!openAiClient) {
        openAiClient = new OpenAI({
          apiKey: config.openAiApiKey,
          baseURL: config.openAiBaseUrl,
        });
        setOpenAIAPI("chat_completions");
        setDefaultOpenAIClient(openAiClient);
      }

      await logChatWorkflowStep({
        config,
        traceId,
        stage: "openai_agent_client_ready",
        query,
        data: {
          reusedOpenAiClient,
          apiMode: "chat_completions",
          baseUrl: config.openAiBaseUrl,
          chatModel: config.openAiChatModel,
        },
      });

      const citationRegistry = createCitationRegistry();
      await logChatWorkflowStep({
        config,
        traceId,
        stage: "citation_registry_created",
        query,
        data: {
          initialCitationCount: 0,
        },
      });

      const retrieveContextTool = createRetrieveContextTool({
        retrievalService,
        citationRegistry,
        baseTopK: topK,
        baseFilter: filter,
        defaultTopK: config.defaultTopK,
        config,
        traceId,
        toolTraceCollector,
      });
      await logChatWorkflowStep({
        config,
        traceId,
        stage: "retrieve_context_tool_created",
        query,
        data: {
          toolName: "retrieve_context",
          defaultTopK: config.defaultTopK,
          baseTopK: topK || null,
          hasBaseFilter: Boolean(filter && Object.keys(filter).length),
          baseFilter: filter || {},
          maxAgentToolTopK: MAX_AGENT_TOOL_TOP_K,
        },
      });

      const agent = createChatAgent({
        config,
        retrieveContextTool,
      });
      await logChatWorkflowStep({
        config,
        traceId,
        stage: "chat_agent_created",
        query,
        data: {
          agentName: "URL Knowledge Base Agent",
          model: config.openAiChatModel,
          toolChoice: "required",
          resetToolChoice: true,
          toolUseBehavior: "run_llm_again",
          maxTurns: 6,
        },
      });

      const sanitizedHistory = sanitizeHistory(history);
      const conversationInput = buildAgentConversationInput({
        query,
        history: sanitizedHistory,
      });
      await logChatWorkflowStep({
        config,
        traceId,
        stage: "agent_run_started",
        query,
        data: {
          conversationInputPreview: previewText(conversationInput),
          sanitizedHistoryCount: sanitizedHistory.length,
          maxTurns: 6,
        },
      });

      const result = await run(
        agent,
        conversationInput,
        { maxTurns: 6 },
      );
      const answer = String(result.finalOutput || "").trim();
      const chunks = citationRegistry.getChunks();
      const citations = citationRegistry.getCitations();

      await logChatWorkflowStep({
        config,
        traceId,
        stage: "agent_run_completed",
        query,
        data: {
          finalOutputLength: answer.length,
          answerPreview: previewText(answer),
          registeredChunkCount: chunks.length,
          registeredCitationCount: citations.length,
          toolCallCount: toolTraceCollector.length,
          toolCalls: toolTraceCollector.map((toolCall) => ({
            toolCallIndex: toolCall.toolCallIndex,
            query: toolCall.query,
            appliedTopK: toolCall.appliedTopK,
            appliedFilter: toolCall.appliedFilter,
            resultCount: toolCall.resultCount,
            error: toolCall.error,
          })),
        },
      });

      if (debugContext && typeof debugContext === "object") {
        debugContext.traceId = traceId;
        debugContext.toolCalls = toolTraceCollector;
      }

      if (!chunks.length) {
        const emptyResult = {
          answer: "I could not find relevant chunks in the indexed URL knowledge base.",
          citations: [],
          chunks: [],
        };
        await logChatWorkflowStep({
          config,
          traceId,
          stage: "answer_query_no_chunks",
          query,
          data: {
            toolCallCount: toolTraceCollector.length,
            answerPreview: emptyResult.answer,
          },
        });
        await logChatInteraction({
          config,
          traceId,
          query,
          topK,
          filter,
          history,
          requestSource,
          toolCalls: toolTraceCollector,
          ...emptyResult,
        });
        return emptyResult;
      }

      const finalResult = {
        answer:
          answer || "I could not generate a grounded answer from the retrieved context.",
        citations,
        chunks,
      };
      await logChatWorkflowStep({
        config,
        traceId,
        stage: "answer_query_success",
        query,
        data: {
          answerPreview: previewText(finalResult.answer),
          citationCount: finalResult.citations.length,
          chunkCount: finalResult.chunks.length,
          toolCallCount: toolTraceCollector.length,
          citations: finalResult.citations.map((citation) => ({
            citationIndex: citation.citationIndex,
            title: citation.title,
            url: citation.url,
            score: citation.score,
          })),
        },
      });
      await logChatInteraction({
        config,
        traceId,
        query,
        topK,
        filter,
        history,
        requestSource,
        toolCalls: toolTraceCollector,
        ...finalResult,
      });
      return finalResult;
    } catch (error) {
      if (debugContext && typeof debugContext === "object") {
        debugContext.traceId = traceId;
        debugContext.toolCalls = toolTraceCollector;
      }
      await logChatWorkflowStep({
        config,
        traceId,
        stage: "answer_query_error",
        query,
        data: {
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                }
              : String(error),
          toolCallCount: toolTraceCollector.length,
        },
      });
      await logChatInteraction({
        config,
        traceId,
        query,
        topK,
        filter,
        history,
        requestSource,
        answer: null,
        citations: [],
        chunks: [],
        toolCalls: toolTraceCollector,
        error,
      });
      throw error;
    }
  };
}
