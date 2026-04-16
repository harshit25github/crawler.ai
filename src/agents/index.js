import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildApp, startServer } from "../api/index.js";
import { createKbSystem } from "../services/kb-system.js";
import { config as baseConfig, readLinesFile } from "../indexing/index.js";

export { buildApp, startServer } from "../api/index.js";
export { createKbSystem, buildKbConfig } from "../services/kb-system.js";
export { createChatAgent, buildAgentConversationInput } from "./chat-agent.js";
export {
  createCitationRegistry,
  createRetrieveContextExecutor,
  createRetrieveContextTool,
  MAX_AGENT_TOOL_TOP_K,
  RETRIEVE_CONTEXT_TOOL_NAME,
} from "./retrieve-context-tool.js";

function printUsage() {
  console.log(`Usage:
  node src/agents/index.js server
  node src/agents/index.js ingest <urlsFileOrUrl> [--force]
  node src/agents/index.js ingest-run <runDir>
  node src/agents/index.js retrieve "<query>" [--topK=6] [--domain=example.com] [--url=https://...] [--sourceType=privacy_policy] [--airline=Delta]
  node src/agents/index.js chat "<query>" [--topK=6] [--domain=example.com] [--url=https://...] [--sourceType=privacy_policy] [--airline=Delta]`);
}

function parseFlags(args) {
  const flags = {};

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, value] = arg.slice(2).split("=");
    flags[key] = value ?? true;
  }

  return flags;
}

async function runCli(command, rest) {
  const kb = createKbSystem();
  const flags = parseFlags(rest);
  const positional = rest.filter((arg) => !arg.startsWith("--"));

  if (command === "ingest") {
    const input = positional[0];

    if (!input) {
      throw new Error("Provide a URL or a file path.");
    }

    const urls = input.startsWith("http")
      ? [input]
      : await readLinesFile(resolve(kb.config.paths.rootDir, input));

    const result = await kb.ingestUrls(urls, {
      force: Boolean(flags.force),
    });

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "retrieve") {
    const query = positional.join(" ").trim();

    if (!query) {
      throw new Error("Provide a retrieval query.");
    }

    const results = await kb.retrieve(query, {
      topK: flags.topK ? Number(flags.topK) : undefined,
      filter: {
        domain: flags.domain,
        url: flags.url,
        sourceType: flags.sourceType,
        airline: flags.airline,
        facet: flags.facet,
      },
    });

    console.log(JSON.stringify({ query, results }, null, 2));
    return;
  }

  if (command === "chat") {
    const query = positional.join(" ").trim();

    if (!query) {
      throw new Error("Provide a chat query.");
    }

    const result = await kb.answerQuery({
      query,
      topK: flags.topK ? Number(flags.topK) : undefined,
      filter: {
        domain: flags.domain,
        url: flags.url,
        sourceType: flags.sourceType,
        airline: flags.airline,
        facet: flags.facet,
      },
      requestSource: "cli",
    });

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "ingest-run") {
    const input = positional[0];

    if (!input) {
      throw new Error("Provide a crawl run directory.");
    }

    const result = await kb.ingestRunDirectory(
      resolve(kb.config.paths.rootDir, input),
    );

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printUsage();
  process.exit(1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    printUsage();
    process.exit(1);
  }

  if (command === "server") {
    await startServer({
      app: buildApp({ enableTestInject: false }),
      port: baseConfig.port,
      host: "0.0.0.0",
    });
    return;
  }

  await runCli(command, rest);
}

const isDirectRun =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main()
    .then(() => {
      if (process.argv[2] !== "server") {
        process.exit(0);
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
