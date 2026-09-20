import ms, { type StringValue } from "ms";
import type { ReviewBackend } from "./review";
import { loadModelConnection, type ModelConnection } from "./model";

export const DEFAULT_BACKEND: ReviewBackend = "opencode";
export const DEFAULT_OPENCODE_VERSION = "1.18.31";
export const DEFAULT_PI_VERSION = "0.85.1";
export const DEFAULT_CGC_VERSION = "0.6.13";
export const DEFAULT_GITNEXUS_VERSION = "1.6.12";
export const DEFAULT_CODE_INDEX_CACHE_KEY = "code-review-index-v1";
export const DEFAULT_CODE_INDEX_CACHE_TTL = "24h";

export type CodeIndexer = "none" | "cgc" | "gitnexus";

const DEFAULT_PROMPT =
  "Focus on correctness, security, regressions, and missing tests.";

export interface ActionConfig {
  githubToken: string;
  connection: ModelConnection;
  backend: ReviewBackend;
  containerEngine: "podman" | "docker";
  prompt: string;
  opencodeVersion: string;
  piVersion: string;
  codeIndexer: CodeIndexer;
  codeIndexCacheKey: string;
  codeIndexCacheTtlMs: number;
  maxDiffBytes: number;
  timeoutMs: number;
}

export function managedCommentMarkers(backend: ReviewBackend): string[] {
  const current = `<!-- code-review:${backend}:v3 -->`;
  const previous = `<!-- code-review:${backend}:openrouter-poc:v2 -->`;
  return backend === "opencode"
    ? [current, previous, "<!-- code-review:opencode-poc:v1 -->"]
    : [current, previous];
}

function inputCandidates(name: string): string[] {
  const upper = name.toUpperCase();
  return [
    `INPUT_${upper}`,
    `INPUT_${upper.replace(/[^A-Z0-9]/g, "_")}`,
  ];
}

export function getActionInput(
  name: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  for (const candidate of inputCandidates(name)) {
    const value = environment[candidate]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseDuration(
  value: string,
  name: string,
  minimumMs: number,
  maximumMs: number,
): number {
  if (!/^\d+(?:ms|s|m|h|d)$/.test(value)) {
    throw new Error(`${name} must be a duration such as 30m, 24h, or 7d`);
  }
  const parsed = ms(value as StringValue);
  if (parsed < minimumMs || parsed > maximumMs) {
    throw new Error(`${name} must be between ${ms(minimumMs)} and ${ms(maximumMs)}`);
  }
  return parsed;
}

function exactVersion(value: string, name: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${name} must be an exact semantic version`);
  }
  return value;
}

export function loadActionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ActionConfig {
  const githubToken = getActionInput("github-token", environment);
  if (!githubToken) {
    throw new Error("github-token is required");
  }

  if (getActionInput("openrouter-api-key", environment) || getActionInput("model", environment)) {
    throw new Error("openrouter-api-key and model have been removed; migrate to model-config and model-credentials (see README)");
  }
  const modelConfig = getActionInput("model-config", environment);
  if (!modelConfig) throw new Error("model-config is required; see README for OpenRouter and local examples");
  const connection = loadModelConnection(modelConfig, getActionInput("model-credentials", environment));

  const backend = getActionInput("backend", environment) ?? DEFAULT_BACKEND;
  if (backend !== "opencode" && backend !== "pi") {
    throw new Error("backend must be opencode or pi");
  }

  const containerEngine =
    getActionInput("container-engine", environment) ?? "podman";
  if (containerEngine !== "podman" && containerEngine !== "docker") {
    throw new Error("container-engine must be podman or docker");
  }

  const prompt = getActionInput("prompt", environment) ?? DEFAULT_PROMPT;
  if (Buffer.byteLength(prompt, "utf8") > 10_000) {
    throw new Error("prompt must not exceed 10000 UTF-8 bytes");
  }

  const opencodeVersion = exactVersion(
    getActionInput("opencode-version", environment) ??
      DEFAULT_OPENCODE_VERSION,
    "opencode-version",
  );
  const piVersion = exactVersion(
    getActionInput("pi-version", environment) ?? DEFAULT_PI_VERSION,
    "pi-version",
  );
  const codeIndexer =
    getActionInput("code-indexer", environment) ?? "none";
  if (
    codeIndexer !== "none" &&
    codeIndexer !== "cgc" &&
    codeIndexer !== "gitnexus"
  ) {
    throw new Error("code-indexer must be none, cgc, or gitnexus");
  }
  const codeIndexCacheKey =
    getActionInput("code-index-cache-key", environment) ??
    DEFAULT_CODE_INDEX_CACHE_KEY;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(codeIndexCacheKey)) {
    throw new Error(
      "code-index-cache-key must contain 1-80 letters, digits, dots, underscores, or hyphens",
    );
  }
  const codeIndexCacheTtlMs = parseDuration(
    getActionInput("code-index-cache-ttl", environment) ??
      DEFAULT_CODE_INDEX_CACHE_TTL,
    "code-index-cache-ttl",
    5 * 60_000,
    30 * 24 * 60 * 60_000,
  );
  const maxDiffBytes = parseInteger(
    getActionInput("max-diff-bytes", environment) ?? "120000",
    "max-diff-bytes",
    1_000,
    500_000,
  );
  const timeoutSeconds = parseInteger(
    getActionInput("timeout-seconds", environment) ?? "600",
    "timeout-seconds",
    30,
    900,
  );

  return {
    githubToken,
    connection,
    backend,
    containerEngine,
    prompt,
    opencodeVersion,
    piVersion,
    codeIndexer,
    codeIndexCacheKey,
    codeIndexCacheTtlMs,
    maxDiffBytes,
    timeoutMs: timeoutSeconds * 1_000,
  };
}
