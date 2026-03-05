import { resolve } from "node:path";
import { createServices } from "./bootstrap.js";
import { readLinesFile } from "./lib/files.js";

function printUsage() {
  console.log(`Usage:
  node src/cli.js ingest <urlsFileOrUrl> [--force]
  node src/cli.js retrieve "<query>" [--topK=6] [--domain=example.com] [--url=https://...]
  node src/cli.js chat "<query>" [--topK=6] [--domain=example.com] [--url=https://...]`);
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const services = createServices();
  const flags = parseFlags(rest);
  const positional = rest.filter((arg) => !arg.startsWith("--"));

  if (!command) {
    printUsage();
    process.exit(1);
  }

  if (command === "ingest") {
    const input = positional[0];

    if (!input) {
      throw new Error("Provide a URL or a file path.");
    }

    const urls = input.startsWith("http")
      ? [input]
      : await readLinesFile(resolve(services.config.paths.rootDir, input));

    const result = await services.ingestionService.ingestUrls(urls, {
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

    const results = await services.retrievalService.retrieve(query, {
      topK: flags.topK ? Number(flags.topK) : undefined,
      filter: {
        domain: flags.domain,
        url: flags.url,
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

    const result = await services.agentService.answerQuery({
      query,
      topK: flags.topK ? Number(flags.topK) : undefined,
      filter: {
        domain: flags.domain,
        url: flags.url,
      },
    });

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printUsage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
