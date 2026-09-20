import type { ReviewBackend } from "./review";

export const DEFAULT_BACKEND: ReviewBackend = "opencode";
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";
export const DEFAULT_OPENCODE_VERSION = "1.18.31";
export const DEFAULT_PI_VERSION = "0.85.1";

const DEFAULT_PROMPT =
  "Focus on correctness, security, regressions, and missing tests.";

export interface ActionConfig {
  githubToken: string;
  openRouterApiKey: string;
  backend: ReviewBackend;
  containerEngine: "podman" | "docker";
  model: string;
  prompt: string;
  opencodeVersion: string;
  piVersion: string;
  maxDiffBytes: number;
  timeoutMs: number;
}

export function managedCommentMarkers(backend: ReviewBackend): string[] {
  const current = `<!-- code-review:${backend}:openrouter-poc:v2 -->`;
  return backend === "opencode"
    ? [current, "<!-- code-review:opencode-poc:v1 -->"]
    : [current];
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

  const openRouterApiKey = getActionInput(
    "openrouter-api-key",
    environment,
  );
  if (!openRouterApiKey) {
    throw new Error("openrouter-api-key is required");
  }

  const backend = getActionInput("backend", environment) ?? DEFAULT_BACKEND;
  if (backend !== "opencode" && backend !== "pi") {
    throw new Error("backend must be opencode or pi");
  }

  const containerEngine =
    getActionInput("container-engine", environment) ?? "podman";
  if (containerEngine !== "podman" && containerEngine !== "docker") {
    throw new Error("container-engine must be podman or docker");
  }

  const model = getActionInput("model", environment) ?? DEFAULT_MODEL;
  if (model !== DEFAULT_MODEL) {
    throw new Error(`The POC supports only ${DEFAULT_MODEL}`);
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
    openRouterApiKey,
    backend,
    containerEngine,
    model,
    prompt,
    opencodeVersion,
    piVersion,
    maxDiffBytes,
    timeoutMs: timeoutSeconds * 1_000,
  };
}
