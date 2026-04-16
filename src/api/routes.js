import { createApiHandlers } from "./handlers.js";
import { asyncHandler } from "./request-utils.js";

export function registerApiRoutes(app, kb, options = {}) {
  const handlers = createApiHandlers(kb, options);

  app.get("/health", handlers.health);
  app.get("/api/docs", handlers.swaggerUi);
  app.get("/api/docs/openapi.json", handlers.openApiJson);
  app.get("/api/ingest/jobs", handlers.listIngestJobs);
  app.get("/api/ingest/jobs/:jobId", handlers.getIngestJob);
  app.post("/api/ingest", asyncHandler(handlers.ingest));
  app.post("/api/retrieve", asyncHandler(handlers.retrieve));
  app.post("/api/chat", asyncHandler(handlers.chat));
  app.post("/api/chat/baggage", asyncHandler(handlers.baggageChat));

  return app;
}
