import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = buildApp();

app.listen({ port: config.port, host: "0.0.0.0" }).catch((error) => {
  console.error(error);
  process.exit(1);
});
