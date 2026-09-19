import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL,
  getActionInput,
  loadActionConfig,
} from "../src/config";

test("reads hyphenated action input names", () => {
  assert.equal(
    getActionInput("github-token", { "INPUT_GITHUB-TOKEN": " token " }),
    "token",
  );
  assert.equal(
    getActionInput("github-token", { INPUT_GITHUB_TOKEN: "token" }),
    "token",
  );
});

test("loads safe defaults", () => {
  const config = loadActionConfig({ INPUT_GITHUB_TOKEN: "secret" });
  assert.equal(config.containerEngine, "podman");
  assert.equal(config.model, DEFAULT_MODEL);
  assert.equal(config.maxDiffBytes, 120_000);
  assert.equal(config.timeoutMs, 600_000);
});

test("requires the explicit github-token input", () => {
  assert.throws(
    () => loadActionConfig({ GH_TOKEN: "ambient-token" }),
    /github-token is required/,
  );
});

test("rejects an unknown container engine", () => {
  assert.throws(
    () =>
      loadActionConfig({
        INPUT_GITHUB_TOKEN: "secret",
        INPUT_CONTAINER_ENGINE: "sh",
      }),
    /must be podman or docker/,
  );
});

test("rejects a model outside POC scope", () => {
  assert.throws(
    () =>
      loadActionConfig({
        INPUT_GITHUB_TOKEN: "secret",
        INPUT_MODEL: "openrouter/paid-model",
      }),
    /supports only opencode\/big-pickle/,
  );
});

test("requires an exact OpenCode version", () => {
  assert.throws(
    () =>
      loadActionConfig({
        INPUT_GITHUB_TOKEN: "secret",
        INPUT_OPENCODE_VERSION: "latest",
      }),
    /exact semantic version/,
  );
});

test("rejects an oversized prompt", () => {
  assert.throws(
    () =>
      loadActionConfig({
        INPUT_GITHUB_TOKEN: "secret",
        INPUT_PROMPT: "x".repeat(10_001),
      }),
    /must not exceed/,
  );
});
