export function buildOpenCodeCommand(input: { version: string }): string[] {
  return [
    'npx',
    '--yes',
    `opencode-ai@${input.version}`,
    'run',
    '--pure',
    '--model',
    'review-provider/review-model',
    '--format',
    'json',
  ];
}

export function extractOpenCodeAssistantText(output: string): string {
  const textParts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (typeof event !== 'object' || event === null) {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (record.type === 'error') {
      throw new Error('OpenCode reported a provider error; backend details suppressed');
    }
    if (record.type !== 'text') {
      continue;
    }

    const part = record.part;
    if (typeof part !== 'object' || part === null) {
      continue;
    }
    const value = (part as Record<string, unknown>).text;
    if (typeof value === 'string') {
      textParts.push(value);
    }
  }

  const review = textParts.join('');
  if (!review.trim()) {
    throw new Error('OpenCode returned no review text');
  }
  return review;
}

export const parseOpenCodeJson = extractOpenCodeAssistantText;
