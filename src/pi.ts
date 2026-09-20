export function buildPiCommand(input: {
  version: string;
  model: string;
}): string[] {
  return [
    "npx",
    "--yes",
    `@earendil-works/pi-coding-agent@${input.version}`,
    "--mode",
    "json",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--provider",
    "openrouter",
    "--model",
    input.model,
    "--offline",
  ];
}

export function parsePiJson(output: string): string {
  let review = "";
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Pi emitted invalid JSON on line ${index + 1}`);
    }

    if (typeof event !== "object" || event === null) {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (record.type !== "message_end") {
      continue;
    }

    const message = record.message;
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role !== "assistant") {
      continue;
    }
    if (messageRecord.stopReason === "error") {
      throw new Error(
        `Pi reported an error: ${String(messageRecord.errorMessage ?? "unknown error").slice(0, 2_000)}`,
      );
    }

    const content = messageRecord.content;
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string",
      )
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) {
      review = text;
    }
  }

  if (!review) {
    throw new Error("Pi returned no review text");
  }
  return review;
}
