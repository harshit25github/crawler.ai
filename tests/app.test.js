import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

test("health route responds with status ok", async () => {
  const app = buildApp();

  try {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: "ok",
      collection: "url_kb",
    });
  } finally {
    await app.close();
  }
});
