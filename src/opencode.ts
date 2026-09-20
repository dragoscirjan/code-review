export const OPENCODE_CONFIG_CONTENT = JSON.stringify({
  permission: { "*": "deny" },
});

export function buildOpenCodeCommand(input: {
  version: string;
  model: string;
}): string[] {
  return [
    "npx",
    "--yes",
    `opencode-ai@${input.version}`,
    "run",
    "--pure",
    "--model",
    `openrouter/${input.model}`,
    "--format",
    "json",
  ];
}

export function parseOpenCodeJson(output: string): string {
  const textParts: string[] = [];
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`OpenCode emitted invalid JSON on line ${index + 1}`);
    }

    if (typeof event !== "object" || event === null) {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (record.type === "error") {
      throw new Error(
        `OpenCode reported an error: ${JSON.stringify(record).slice(0, 2_000)}`,
      );
    }
    if (record.type !== "text") {
      continue;
    }

    const part = record.part;
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const value = (part as Record<string, unknown>).text;
    if (typeof value === "string" && value.trim()) {
      textParts.push(value.trim());
    }
  }

  const review = textParts.join("\n\n").trim();
  if (!review) {
    throw new Error("OpenCode returned no review text");
  }
  return review;
}
