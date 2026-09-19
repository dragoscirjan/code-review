export const DEFAULT_MODEL = "opencode/big-pickle";
export const DEFAULT_OPENCODE_VERSION = "1.18.31";
export const MANAGED_COMMENT_MARKER = "<!-- code-review:opencode-poc:v1 -->";

const DEFAULT_PROMPT =
  "Focus on correctness, security, regressions, and missing tests.";

export interface ActionConfig {
  githubToken: string;
  containerEngine: "podman" | "docker";
  model: string;
  prompt: string;
  opencodeVersion: string;
  maxDiffBytes: number;
  timeoutMs: number;
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

export function loadActionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ActionConfig {
  const githubToken = getActionInput("github-token", environment);
  if (!githubToken) {
    throw new Error("github-token is required");
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

  const opencodeVersion =
    getActionInput("opencode-version", environment) ??
    DEFAULT_OPENCODE_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(opencodeVersion)) {
    throw new Error("opencode-version must be an exact semantic version");
  }

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
    containerEngine,
    model,
    prompt,
    opencodeVersion,
    maxDiffBytes,
    timeoutMs: timeoutSeconds * 1_000,
  };
}
