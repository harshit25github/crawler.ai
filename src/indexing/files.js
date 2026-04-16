import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function readJson(path) {
  const content = await readFile(path, "utf8");
  return JSON.parse(content);
}

async function writeJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readLinesFile(path) {
  const content = await readFile(path, "utf8");

  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export { ensureDir, readJson, writeJson, readLinesFile };
