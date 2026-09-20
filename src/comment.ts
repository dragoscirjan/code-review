import type { ReviewBackend } from './review';

function backendLabel(backend: ReviewBackend): string {
  return backend === 'opencode' ? 'OpenCode' : 'Pi';
}

export function renderComment(input: {
  review: string;
  backend: ReviewBackend;
  model: string;
  headSha: string;
  actor: string;
  diffTruncated: boolean;
  originalDiffBytes: number;
  marker: string;
}): string {
  const truncation = input.diffTruncated ? `\n\n> Diff input was truncated from ${input.originalDiffBytes} bytes.` : '';
  return `## Code Review (\`${input.model}\` via ${backendLabel(input.backend)})

- Head: \`${input.headSha.slice(0, 12)}\`
- Published through: \`@${input.actor}\`${truncation}

${input.review}

${input.marker}`;
}
