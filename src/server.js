import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./indexing/index.js";
import { buildApp } from "./api/app.js";

export function startServer({
  app = buildApp({ enableTestInject: false }),
  port,
  host = "0.0.0.0",
} = {}) {
  return new Promise((resolveListen, rejectListen) => {
    const server = app.listen(port, host, () => {
      console.log(`Server listening on http://${host}:${port}`);
      resolveListen(server);
    });
    server.on("error", rejectListen);
  });
}

const isDirectRun =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  await startServer({
    app: buildApp({ enableTestInject: false }),
    port: config.port,
    host: "0.0.0.0",
  });
}
