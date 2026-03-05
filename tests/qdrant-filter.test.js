import test from "node:test";
import assert from "node:assert/strict";
import { buildPayloadFilter } from "../src/services/qdrant-service.js";

test("buildPayloadFilter returns undefined for empty filters", () => {
  assert.equal(buildPayloadFilter(), undefined);
});

test("buildPayloadFilter maps domain and url filters", () => {
  assert.deepEqual(
    buildPayloadFilter({
      domain: "www.cheapoair.com",
      url: "https://www.cheapoair.com/info/privacy",
    }),
    {
      must: [
        {
          key: "url",
          match: { value: "https://www.cheapoair.com/info/privacy" },
        },
        {
          key: "domain",
          match: { value: "www.cheapoair.com" },
        },
      ],
    },
  );
});
