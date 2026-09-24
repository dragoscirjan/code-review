import type { AnalyzerSummary } from './analyzer';
import type { ReviewContextMetadata } from './context-planner';
import type { ReviewAssessment, ValidatedFinding } from './finding-validation';
import type { ReviewBackend } from './review';
import type { ReviewLifecycleCounts, ReviewMode, ReviewStateFinding } from './review-lifecycle';
import type { ReviewExecutionSummary } from './review-specialists';
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
${
  finding.origin?.kind === 'analyzer'
    ? `- **Deterministic analyzer:** ${finding.origin.analyzer} (${finding.origin.analyzerVersion}), rule ${finding.origin.ruleId} r${finding.origin.ruleRevision}\n`
    : ''
}- **Path:**
${renderModelTextLiteral(finding.location.path)}
- **Evidence:**
${renderModelTextLiteral(finding.evidence)}
- **Explanation:**
${renderModelTextLiteral(finding.explanation)}
- **Suggested fix:**
${renderModelTextLiteral(finding.fix)}`;
}

function renderAssessment(assessment: ReviewAssessment): string {
  if (assessment.findings.length > 0) {
    return assessment.findings.map((finding, index) => renderFinding(finding, index + 1)).join('\n\n');
  }
  if (assessment.counts.memorySuppressed > 0) {
    return 'No validated findings remain after repository-memory suppressions.';
  }
  if (assessment.modelOutcome === 'clean') return 'No validated findings were returned for the supplied context.';
  return 'No findings passed diff and evidence validation.';
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

/** Collapsible presentation used for provisional and progress findings inside the managed summary. */
function renderCollapsibleFinding(finding: ValidatedFinding): string {
  const summary = `${findingHeading(finding)} — ${renderModelTextLiteral(finding.location.path)}:${finding.location.line} (${finding.location.side})`;
  return `<details>\n<summary>${summary}</summary>\n\n${renderFinding(finding)}\n\n</details>`;
}

/**
 * Renders the in-progress managed summary body: the status header, phase-0 deterministic findings,
 * and every validated shard finding published so far, each collapsible. Findings are dropped from
 * the oldest side when the body approaches the GitHub comment limit; the omission is stated.
 */
export function renderProgressComment(input: {
  assessment: ReviewAssessment;
  backend: ReviewBackend;
  model: string;
  headSha: string;
  actor: string;
  completedShards: number;
  totalShards: number;
  provisionalFindings: readonly ValidatedFinding[];
  marker: string;
}): string {
  const dropped: ValidatedFinding[] = [];
  let shown = [...input.provisionalFindings];
  while (true) {
    const progress = `
- Status: **review in progress** — shards completed ${input.completedShards} / ${input.totalShards}`;
    const findings = shown.length > 0 ? shown.map(renderCollapsibleFinding).join('\n\n') : '';
    const omitted =
      dropped.length > 0
        ? `\n\n> ${dropped.length} provisional finding block${dropped.length === 1 ? ' was' : 's were'} omitted to fit the GitHub comment limit.`
        : '';
    const counts = input.assessment.counts;
    const comment = `## Code Review (\`${input.model}\` via ${backendLabel(input.backend)})

- Head: \`${input.headSha.slice(0, 12)}\`
- Published through: \`@${input.actor}\`${progress}${counts.received > 0 ? `\n- Accepted deterministic findings: ${counts.accepted}` : ''}

${findings}${omitted}

${input.marker}`;
    if (comment.length <= MAX_GITHUB_COMMENT_BYTES && Buffer.byteLength(comment, 'utf8') <= MAX_GITHUB_COMMENT_BYTES)
      return comment;
    if (shown.length === 0) return assertCommentSize(comment, 'Rendered progressive review comment');
    dropped.push(shown[0] as ValidatedFinding);
    shown = shown.slice(1);
  }
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
  analyzerSummary?: AnalyzerSummary;
  executionSummary?: ReviewExecutionSummary;
  /** Present when the sharded review ended before covering every shard. */
  coverage?: { degraded: boolean; notCoveredShards: number; totalShards: number; provisionalFindings: number };
  memory?: {
    mode: 'none' | 'base-config';
    status: 'disabled' | 'missing' | 'enabled';
    activeSuppressions: number;
    activePreferences: number;
    suppressedCandidates: number;
    applications: readonly { id: string; repositoryDeclaredAuthor: string; digest: string }[];
  };
  lifecycle?: {
    mode: ReviewMode;
    reason: string;
    fromHeadSha: string | null;
    counts: ReviewLifecycleCounts;
    active: readonly ReviewStateFinding[];
    tombstones: readonly ReviewStateFinding[];
    stateLine: string;
  };
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
  const analysis = input.analyzerSummary
    ? `
- Deterministic analysis: ${input.analyzerSummary.configStatus}; ${input.analyzerSummary.coverage} coverage
- Analyzer runs: ${input.analyzerSummary.runCount}
- Analyzer observations accepted: ${input.analyzerSummary.acceptedObservations}
- Analyzer files skipped: ${input.analyzerSummary.skippedFiles}
- Analyzer observations outside changed additions: ${input.analyzerSummary.outOfScopeObservations}
- Analyzer context truncated: ${input.analyzerSummary.contextTruncated ? 'yes' : 'no'}`
    : '';
  const execution = input.executionSummary
    ? `
- Requested review strategy: ${input.executionSummary.plan.requested}
- Selected review strategy: ${input.executionSummary.plan.selected}
- Strategy reasons: ${input.executionSummary.plan.reasons.join(', ')}
- Review passes completed: ${input.executionSummary.rolesCompleted}
- Raw specialist candidates: ${input.executionSummary.rawCandidateCount}
- Candidates validated for arbitration: ${input.executionSummary.validatedCandidateCount}
- Candidates omitted before arbitration: ${input.executionSummary.preArbiterOmittedCount}
- Candidates rejected by arbiter: ${input.executionSummary.arbiterRejectedCount}
- Reserved specialist token units: ${input.executionSummary.reservedTokens}`
    : '';
  const memory = input.memory
    ? `
- Repository review memory: ${input.memory.status} (${input.memory.mode})
- Active memory suppressions: ${input.memory.activeSuppressions}
- Active additional-scrutiny preferences: ${input.memory.activePreferences}
- Validated candidates suppressed by repository memory: ${input.memory.suppressedCandidates}${
        input.memory.applications.length > 0
          ? `\n- Applied repository-declared memory entries: ${input.memory.applications
              .map(
                (entry) =>
                  `\`${entry.id}\` with repository-recorded author \`${entry.repositoryDeclaredAuthor}\` (\`${entry.digest}\`)`,
              )
              .join(', ')}`
          : ''
      }`
    : '';
  const lifecycle = input.lifecycle
    ? `
- Review mode: ${input.lifecycle.mode}
- Comparison head: ${input.lifecycle.fromHeadSha ? `\`${input.lifecycle.fromHeadSha.slice(0, 12)}\`` : 'none'}
- Incremental fallback reason: ${input.lifecycle.reason}
- New findings: ${input.lifecycle.counts.new}
- Unchanged findings: ${input.lifecycle.counts.unchanged}
- Resolved findings: ${input.lifecycle.counts.resolved}
- Superseded findings: ${input.lifecycle.counts.superseded}`
    : '';
  const coverage = input.coverage
    ? `\n\n> ⚠️ **Partial review.** The aggregate deadline expired before every shard completed: ${input.coverage.notCoveredShards} of ${input.coverage.totalShards} diff shard${input.coverage.totalShards === 1 ? '' : 's'} ${input.coverage.notCoveredShards === 1 ? 'was' : 'were'} not reviewed. The ${input.coverage.provisionalFindings} finding${input.coverage.provisionalFindings === 1 ? '' : 's'} below ${input.coverage.provisionalFindings === 1 ? 'is' : 'are'} validated but ${input.coverage.provisionalFindings === 1 ? 'was' : 'were'} not confirmed by the final merge pass.\n>`
    : '';
  const compact = input.lifecycle
    ? [
        ...input.lifecycle.active.map(
          (finding) =>
            `- ${finding.state}: ${finding.category}/${finding.severity} at ${renderModelTextLiteral(`${finding.path}:${finding.line} (${finding.side})`)}`,
        ),
        ...input.lifecycle.tombstones.map(
          (finding) =>
            `- ${finding.state}: ${finding.category}/${finding.severity} at ${renderModelTextLiteral(`${finding.path}:${finding.line} (${finding.side})`)}`,
        ),
      ].join('\n')
    : '';
  const details = [...input.assessment.findings];
  let omitted = 0;
  while (true) {
    const detailAssessment: ReviewAssessment = {
      ...input.assessment,
      findings: details,
      inlineFindings: input.assessment.inlineFindings.filter((finding) => details.includes(finding)),
    };
    const detailsText =
      details.length === 0 && input.assessment.findings.length > 0 ? '' : renderAssessment(detailAssessment);
    const omission =
      omitted > 0
        ? `\n\n> ${omitted} detailed finding block${omitted === 1 ? ' was' : 's were'} omitted to fit the GitHub comment limit.`
        : '';
    const state = input.lifecycle ? `\n${input.lifecycle.stateLine}` : '';
    const comment = `## Code Review (\`${input.model}\` via ${backendLabel(input.backend)})

- Head: \`${input.headSha.slice(0, 12)}\`${context}
- Published through: \`@${input.actor}\`${analysis}${execution}${memory}${lifecycle}
- Findings received: ${counts.received}
- Accepted: ${counts.accepted}
- Rejected (evidence or secret policy): ${counts.rejected}
- Unmapped: ${counts.unmapped}
- Duplicates removed: ${counts.duplicates}
- Below confidence threshold: ${counts.belowThreshold}
- Suppressed by repository memory: ${counts.memorySuppressed}
- Inline comments published: ${counts.inlineSelected}
- Inline comments suppressed by publication history: ${counts.inlineHistorySuppressed}
- Accepted findings omitted from inline comments by limit: ${counts.inlineLimitOmitted}${truncation}${coverage}

${compact ? `### Finding lifecycle\n${compact}\n\n` : ''}${detailsText}${omission}
${state}
${input.marker}`;
    if (comment.length <= MAX_GITHUB_COMMENT_BYTES && Buffer.byteLength(comment, 'utf8') <= MAX_GITHUB_COMMENT_BYTES)
      return comment;
    if (details.length === 0) return assertCommentSize(comment, 'Rendered review comment');
    details.pop();
    omitted += 1;
  }
}
