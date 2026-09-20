import assert from "node:assert/strict";
import test from "node:test";
import { getActionInput, loadActionConfig, managedCommentMarkers } from "../src/config";

const base = {
  INPUT_GITHUB_TOKEN: "github-secret",
  INPUT_MODEL_CONFIG: JSON.stringify({ version: 1,
    provider: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", network: "remote", credential: "router" },
    model: { id: "z-ai/glm-5.3-flash" },
  }),
  INPUT_MODEL_CREDENTIALS: JSON.stringify({ router: { type: "bearer", value: "provider-secret" } }),
};

test("reads hyphenated action input names", () => {
  assert.equal(getActionInput("github-token", { "INPUT_GITHUB-TOKEN": " token " }), "token");
  assert.equal(getActionInput("model-config", base), base.INPUT_MODEL_CONFIG);
});

test("loads explicit model config and safe action defaults", () => {
  const config = loadActionConfig(base);
  assert.equal(config.backend, "opencode");
  assert.equal(config.containerEngine, "podman");
  assert.equal(config.connection.modelId, "z-ai/glm-5.3-flash");
  assert.equal(config.codeIndexer, "none");
  assert.equal(config.codeIndexCacheKey, "code-review-index-v1");
  assert.equal(config.codeIndexCacheTtlMs, 86_400_000);
  assert.equal(config.maxDiffBytes, 120_000);
  assert.equal(config.timeoutMs, 600_000);
  assert.equal(loadActionConfig({ ...base, INPUT_BACKEND: "pi" }).backend, "pi");
});

test("requires explicit credentials and configuration; rejects legacy input", () => {
  assert.throws(() => loadActionConfig({ GH_TOKEN: "ambient" }), /github-token is required/);
  assert.throws(() => loadActionConfig({ INPUT_GITHUB_TOKEN: "token" }), /model-config is required/);
  for (const name of ["INPUT_MODEL", "INPUT_OPENROUTER_API_KEY"]) {
    assert.throws(() => loadActionConfig({ ...base, [name]: "old" }), /have been removed/);
  }
});

test("validates action limits and executable selection", () => {
  for (const [name, value, message] of [
    ["INPUT_BACKEND", "bash", /backend must/],
    ["INPUT_CONTAINER_ENGINE", "sh", /container-engine must/],
    ["INPUT_OPENCODE_VERSION", "latest", /exact semantic version/],
    ["INPUT_PI_VERSION", "next", /exact semantic version/],
    ["INPUT_CODE_INDEXER", "both", /must be none/],
    ["INPUT_CODE_INDEX_CACHE_KEY", "bad key", /code-index-cache-key/],
    ["INPUT_CODE_INDEX_CACHE_TTL", "forever", /must be a duration/],
    ["INPUT_PROMPT", "x".repeat(10001), /must not exceed/],
    ["INPUT_MAX_DIFF_BYTES", "1", /max-diff-bytes/],
    ["INPUT_TIMEOUT_SECONDS", "0", /timeout-seconds/],
  ] as const) {
    assert.throws(() => loadActionConfig({ ...base, [name]: value }), message);
  }
  const config = loadActionConfig({ ...base, INPUT_CODE_INDEXER: "gitnexus", INPUT_CODE_INDEX_CACHE_TTL: "7d" });
  assert.equal(config.codeIndexer, "gitnexus");
  assert.equal(config.codeIndexCacheTtlMs, 604800000);
});

test("migrates both backend markers without collisions", () => {
  assert.deepEqual(managedCommentMarkers("opencode"), [
    "<!-- code-review:opencode:v3 -->", "<!-- code-review:opencode:openrouter-poc:v2 -->", "<!-- code-review:opencode-poc:v1 -->",
  ]);
  assert.deepEqual(managedCommentMarkers("pi"), ["<!-- code-review:pi:v3 -->", "<!-- code-review:pi:openrouter-poc:v2 -->"]);
});
