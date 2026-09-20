import type { ReviewContextMetadata } from './context-planner';
import type { ReviewAssessment, ValidatedFinding } from './finding-validation';
import type { ReviewBackend } from './review';
import { renderModelTextLiteral } from './review-text';

export const MAX_GITHUB_COMMENT_BYTES = 65_536;

function backendLabel(backend: ReviewBackend): string {
  return backend === 'opencode' ? 'OpenCode' : 'Pi';
}

function findingHeading(finding: ValidatedFinding): string {
  const severity = `${finding.severity[0].toUpperCase()}${finding.severity.slice(1)}`;
  const category = `${finding.category[0].toUpperCase()}${finding.category.slice(1)}`;
  return `${severity} ${category}`;
}

function renderFinding(finding: ValidatedFinding, index?: number): string {
  const prefix = index === undefined ? '###' : `### ${index}.`;
  return `${prefix} ${findingHeading(finding)}

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
}

function renderAssessment(assessment: ReviewAssessment): string {
  if (assessment.modelOutcome === 'clean') return 'No validated findings were returned for the supplied context.';
  if (assessment.findings.length === 0) return 'No model findings passed diff and evidence validation.';
  return assessment.findings.map((finding, index) => renderFinding(finding, index + 1)).join('\n\n');
}

function assertCommentSize(comment: string, label: string): string {
  if (comment.length > MAX_GITHUB_COMMENT_BYTES || Buffer.byteLength(comment, 'utf8') > MAX_GITHUB_COMMENT_BYTES) {
    throw new Error(`${label} exceeds the publication size limit`);
  }
  return comment;
}

export function renderInlineComment(finding: ValidatedFinding, marker: string): string {
  return assertCommentSize(`${renderFinding(finding)}\n\n${marker}`, 'Rendered inline review comment');
}

export function renderComment(input: {
  assessment: ReviewAssessment;
  backend: ReviewBackend;
  model: string;
  headSha: string;
  actor: string;
  diffTruncated: boolean;
  originalDiffBytes: number;
  contextMetadata?: ReviewContextMetadata;
  marker: string;
}): string {
  const { counts } = input.assessment;
  const truncation = input.diffTruncated
    ? `\n\n> Review context was truncated safely at complete diff-hunk boundaries from ${input.originalDiffBytes} bytes.`
    : '';
  const context = input.contextMetadata
    ? `
- Review context: ${input.contextMetadata.includedBytes} / ${input.contextMetadata.maximumBytes} bytes
- Context sources unavailable: ${input.contextMetadata.unavailableSourceCount}
- Context sources truncated: ${input.contextMetadata.truncated ? 'yes' : 'no'}
- Context queries: ${input.contextMetadata.queriesCompleted} completed, ${input.contextMetadata.queriesTimedOut} timed out, ${input.contextMetadata.queryBudgetSkipped} skipped by budget
- Base guidance: AGENTS.md ${input.contextMetadata.guidance.agents}; CONTRIBUTING.md ${input.contextMetadata.guidance.contributing}
- Base configuration: ${input.contextMetadata.configuration.included} included, ${input.contextMetadata.configuration.unavailable} unavailable, ${input.contextMetadata.configuration.truncated} truncated
- Linked issue criteria: ${input.contextMetadata.linkedIssues.fetched} included, ${input.contextMetadata.linkedIssues.unavailable} unavailable`
    : '';
  const comment = `## Code Review (\`${input.model}\` via ${backendLabel(input.backend)})

- Head: \`${input.headSha.slice(0, 12)}\`${context}
- Published through: \`@${input.actor}\`
- Model findings received: ${counts.received}
- Accepted: ${counts.accepted}
- Rejected (evidence or secret policy): ${counts.rejected}
- Unmapped: ${counts.unmapped}
- Duplicates removed: ${counts.duplicates}
- Below confidence threshold: ${counts.belowThreshold}
- Inline comments published: ${counts.inlineSelected}
- Accepted findings omitted from inline comments by limit: ${counts.inlineOmitted}${truncation}

${renderAssessment(input.assessment)}

${input.marker}`;
  return assertCommentSize(comment, 'Rendered review comment');
}
