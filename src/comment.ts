import type { ReviewBackend } from './review';
import type { ReviewResultV1 } from './review-contract';
import { renderModelTextLiteral } from './review-text';

export const MAX_GITHUB_COMMENT_BYTES = 65_536;

function backendLabel(backend: ReviewBackend): string {
  return backend === 'opencode' ? 'OpenCode' : 'Pi';
}

function renderReview(review: ReviewResultV1): string {
  if (review.outcome === 'clean') return 'No material findings.';

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const findings = review.findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => severityOrder[left.finding.severity] - severityOrder[right.finding.severity]);

  return findings
    .map(({ finding }, index) => {
      const severity = `${finding.severity[0].toUpperCase()}${finding.severity.slice(1)}`;
      const category = `${finding.category[0].toUpperCase()}${finding.category.slice(1)}`;
      return `### ${index + 1}. ${severity} ${category}

- **Line:** ${finding.location.line} (${finding.location.side})
- **Confidence:** ${Math.round(finding.confidence * 100)}%
- **Path:**
${renderModelTextLiteral(finding.location.path)}
- **Evidence:**
${renderModelTextLiteral(finding.evidence)}
- **Explanation:**
${renderModelTextLiteral(finding.explanation)}
- **Suggested fix:**
${renderModelTextLiteral(finding.fix)}`;
    })
    .join('\n\n');
}

export function renderComment(input: {
  review: ReviewResultV1;
  backend: ReviewBackend;
  model: string;
  headSha: string;
  actor: string;
  diffTruncated: boolean;
  originalDiffBytes: number;
  marker: string;
}): string {
  const truncation = input.diffTruncated ? `\n\n> Diff input was truncated from ${input.originalDiffBytes} bytes.` : '';
  const comment = `## Code Review (\`${input.model}\` via ${backendLabel(input.backend)})

- Head: \`${input.headSha.slice(0, 12)}\`
- Published through: \`@${input.actor}\`${truncation}

${renderReview(input.review)}

${input.marker}`;
  if (comment.length > MAX_GITHUB_COMMENT_BYTES || Buffer.byteLength(comment, 'utf8') > MAX_GITHUB_COMMENT_BYTES) {
    throw new Error('Rendered review comment exceeds the publication size limit');
  }
  return comment;
}
