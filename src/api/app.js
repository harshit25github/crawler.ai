import express from "express";
import { createKbSystem } from "../services/kb-system.js";
import { createIngestJobManager } from "./ingest-job-manager.js";
import { registerApiRoutes } from "./routes.js";
import { errorHandler } from "./request-utils.js";
import { attachTestCompatibility } from "./inject-compat.js";

export function buildApp({ enableTestInject = true } = {}) {
  const kb = createKbSystem();
  const ingestJobManager = createIngestJobManager({ kb });
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  registerApiRoutes(app, kb, { ingestJobManager });
  app.use(errorHandler);

  if (enableTestInject) {
    attachTestCompatibility(app);
  }

  return app;
}
