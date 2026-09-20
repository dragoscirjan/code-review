import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BACKEND,
  DEFAULT_MODEL,
  getActionInput,
  loadActionConfig,
  managedCommentMarker,
} from "../src/config";

test("reads hyphenated action input names", () => {
  assert.equal(
    getActionInput("github-token", { "INPUT_GITHUB-TOKEN": " token " }),
    "token",
  );
  assert.equal(
    getActionInput("openrouter-api-key", {
      INPUT_OPENROUTER_API_KEY: "key",
    }),
    "key",
  );
});

test("loads safe OpenRouter defaults", () => {
  const config = loadActionConfig({
    INPUT_GITHUB_TOKEN: "github-secret",
    INPUT_OPENROUTER_API_KEY: "provider-secret",
  });
  assert.equal(config.backend, DEFAULT_BACKEND);
  assert.equal(config.containerEngine, "podman");
  assert.equal(config.model, DEFAULT_MODEL);
  assert.equal(config.maxDiffBytes, 120_000);
  assert.equal(config.timeoutMs, 600_000);
});

test("requires explicit GitHub and OpenRouter credentials", () => {
  assert.throws(
    () =>
      loadActionConfig({
        GH_TOKEN: "ambient-token",
        INPUT_OPENROUTER_API_KEY: "provider-secret",
      }),
    /github-token is required/,
  );
  assert.throws(
    () => loadActionConfig({ INPUT_GITHUB_TOKEN: "github-secret" }),
    /openrouter-api-key is required/,
  );
});

test("accepts only the two POC backends", () => {
  const base = {
    INPUT_GITHUB_TOKEN: "github-secret",
    INPUT_OPENROUTER_API_KEY: "provider-secret",
  };
  assert.equal(
    loadActionConfig({ ...base, INPUT_BACKEND: "pi" }).backend,
    "pi",
  );
  assert.throws(
    () => loadActionConfig({ ...base, INPUT_BACKEND: "bash" }),
    /backend must be opencode or pi/,
  );
});

test("rejects an unknown container engine", () => {
  assert.throws(
    () =>
      loadActionConfig({
        INPUT_GITHUB_TOKEN: "github-secret",
        INPUT_OPENROUTER_API_KEY: "provider-secret",
        INPUT_CONTAINER_ENGINE: "sh",
      }),
    /must be podman or docker/,
  );
});

test("rejects a model outside POC scope", () => {
  assert.throws(
    () =>
      loadActionConfig({
        INPUT_GITHUB_TOKEN: "github-secret",
        INPUT_OPENROUTER_API_KEY: "provider-secret",
        INPUT_MODEL: "openrouter/paid-model",
      }),
    /supports only z-ai\/glm-5\.3-flash/,
  );
});

test("requires exact backend package versions", () => {
  const base = {
    INPUT_GITHUB_TOKEN: "github-secret",
    INPUT_OPENROUTER_API_KEY: "provider-secret",
  };
  assert.throws(
    () => loadActionConfig({ ...base, INPUT_OPENCODE_VERSION: "latest" }),
    /opencode-version must be an exact semantic version/,
  );
  assert.throws(
    () => loadActionConfig({ ...base, INPUT_PI_VERSION: "next" }),
    /pi-version must be an exact semantic version/,
  );
});

test("uses a distinct managed marker for each backend", () => {
  assert.notEqual(managedCommentMarker("opencode"), managedCommentMarker("pi"));
});

test("rejects an oversized prompt", () => {
  assert.throws(
    () =>
      loadActionConfig({
        INPUT_GITHUB_TOKEN: "github-secret",
        INPUT_OPENROUTER_API_KEY: "provider-secret",
        INPUT_PROMPT: "x".repeat(10_001),
      }),
    /must not exceed/,
  );
});
