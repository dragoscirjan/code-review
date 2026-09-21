import type { ReviewFinding, ReviewResultV1 } from './review-contract';
import { fingerprintFinding, type FindingFingerprint } from './review-lifecycle';
import type { UnifiedDiff, UnifiedDiffFile, UnifiedDiffLine } from './unified-diff';

export interface FindingPolicy {
  minimumConfidence: number;
  maximumInlineComments: number;
}

export interface ReviewCounts {
  received: number;
  accepted: number;
  rejected: number;
  unmapped: number;
  duplicates: number;
  belowThreshold: number;
  inlineSelected: number;
  inlineHistorySuppressed: number;
  inlineLimitOmitted: number;
  inlineOmitted: number;
}

export interface ValidatedFinding extends ReviewFinding, FindingFingerprint {
  sourceIndex: number;
}

export interface ReviewAssessment {
  modelOutcome: ReviewResultV1['outcome'];
  findings: ValidatedFinding[];
  inlineFindings: ValidatedFinding[];
  counts: ReviewCounts;
}

const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;

function activeSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets)].filter(Boolean);
}

function containsSecret(value: string, secrets: readonly string[]): boolean {
  return activeSecrets(secrets).some((secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return value.includes(secret) || (escaped !== secret && value.includes(escaped));
  });
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function resolveFile(diff: UnifiedDiff, path: string, side: 'LEFT' | 'RIGHT'): UnifiedDiffFile | undefined {
  const matches = diff.files.filter(
    (file) => file.commentable && (side === 'LEFT' ? file.oldPath : file.newPath) === path,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveChangedLine(file: UnifiedDiffFile, side: 'LEFT' | 'RIGHT', line: number): UnifiedDiffLine | undefined {
  const matches = file.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((candidate) => {
      if (side === 'LEFT') return candidate.kind === 'deletion' && candidate.oldLine === line;
      return candidate.kind === 'addition' && candidate.newLine === line;
    });
  return matches.length === 1 ? matches[0] : undefined;
}

function lexicalFinding(finding: ReviewFinding): string {
  return JSON.stringify([
    finding.location.path,
    finding.location.side,
    finding.location.line,
    finding.category,
    finding.severity,
    finding.confidence,
    finding.evidence,
    finding.explanation,
    finding.fix,
  ]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFindings(left: ValidatedFinding, right: ValidatedFinding): number {
  return (
    severityRank[left.severity] - severityRank[right.severity] ||
    right.confidence - left.confidence ||
    compareText(left.location.path, right.location.path) ||
    compareText(left.location.side, right.location.side) ||
    left.location.line - right.location.line ||
    compareText(left.category, right.category) ||
    compareText(lexicalFinding(left), lexicalFinding(right)) ||
    left.sourceIndex - right.sourceIndex
  );
}

function anchorKey(finding: ReviewFinding): string {
  return `${finding.location.path}\0${finding.location.side}\0${finding.location.line}`;
}

/** Maps structurally valid model findings to exact changed lines and returns only evidence-backed findings. */
export function assessReview(
  review: ReviewResultV1,
  diff: UnifiedDiff,
  policy: FindingPolicy,
  secrets: readonly string[] = [],
): ReviewAssessment {
  if (policy.minimumConfidence < 0 || policy.minimumConfidence > 1) {
    throw new Error('minimumConfidence must be between 0 and 1');
  }
  if (
    !Number.isInteger(policy.maximumInlineComments) ||
    policy.maximumInlineComments < 0 ||
    policy.maximumInlineComments > 10
  ) {
    throw new Error('maximumInlineComments must be an integer between 0 and 10');
  }

  let rejected = 0;
  let unmapped = 0;
  let belowThreshold = 0;
  const mapped: ValidatedFinding[] = [];
  review.findings.forEach((finding, sourceIndex) => {
    const file = resolveFile(diff, finding.location.path, finding.location.side);
    if (!file?.apiPath) {
      unmapped += 1;
      return;
    }
    const line = resolveChangedLine(file, finding.location.side, finding.location.line);
    if (!line) {
      unmapped += 1;
      return;
    }
    const evidence = normalizeLineEndings(finding.evidence);
    if (
      evidence.includes('\n') ||
      evidence !== line.text ||
      containsSecret(finding.location.path, secrets) ||
      containsSecret(evidence, secrets)
    ) {
      rejected += 1;
      return;
    }
    if (finding.confidence < policy.minimumConfidence) {
      belowThreshold += 1;
      return;
    }
    const validated = {
      ...finding,
      sourceIndex,
      location: { ...finding.location, path: file.apiPath },
      evidence,
      explanation: normalizeLineEndings(finding.explanation).trim(),
      fix: normalizeLineEndings(finding.fix).trim(),
    };
    mapped.push({ ...validated, ...fingerprintFinding(validated, diff) });
  });

  const winners = new Map<string, ValidatedFinding>();
  for (const finding of mapped) {
    const key = anchorKey(finding);
    const previous = winners.get(key);
    if (!previous || compareFindings(finding, previous) < 0) winners.set(key, finding);
  }
  const findings = [...winners.values()].sort(compareFindings);
  const duplicates = mapped.length - findings.length;
  const inlineFindings = findings.slice(0, policy.maximumInlineComments);
  const counts: ReviewCounts = {
    received: review.findings.length,
    accepted: findings.length,
    rejected,
    unmapped,
    duplicates,
    belowThreshold,
    inlineSelected: inlineFindings.length,
    inlineHistorySuppressed: 0,
    inlineLimitOmitted: findings.length - inlineFindings.length,
    inlineOmitted: findings.length - inlineFindings.length,
  };
  if (
    counts.received !==
    counts.accepted + counts.rejected + counts.unmapped + counts.duplicates + counts.belowThreshold
  ) {
    throw new Error('Review assessment counts are inconsistent');
  }
  return { modelOutcome: review.outcome, findings, inlineFindings, counts };
}
