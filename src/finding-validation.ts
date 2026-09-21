import type { AnalyzerFindingCandidate } from './analyzer-contract';
import type { ReviewFinding, ReviewResultV1 } from './review-contract';
import { fingerprintFinding, type FindingFingerprint } from './review-lifecycle';
import {
  applyReviewMemory,
  memoryPreferencePriority,
  type AppliedMemoryEntry,
  type ReviewMemory,
} from './review-memory';
import type { UnifiedDiff, UnifiedDiffFile, UnifiedDiffLine } from './unified-diff';

export interface FindingPolicy {
  minimumConfidence: number;
  maximumInlineComments: number;
}

export interface ReviewCounts {
  received: number;
  accepted: number;
  rejected: number;
  evidenceRejected: number;
  globalLimitOmitted: number;
  unmapped: number;
  duplicates: number;
  belowThreshold: number;
  memorySuppressed: number;
  inlineSelected: number;
  inlineHistorySuppressed: number;
  inlineLimitOmitted: number;
  inlineOmitted: number;
}

export type FindingOrigin = { kind: 'model' } | AnalyzerFindingCandidate['origin'];

export interface ValidatedFinding extends ReviewFinding, FindingFingerprint {
  sourceIndex: number;
  origin?: FindingOrigin;
}

export interface ReviewAssessment {
  modelOutcome: ReviewResultV1['outcome'];
  findings: ValidatedFinding[];
  inlineFindings: ValidatedFinding[];
  counts: ReviewCounts;
  memoryApplications: AppliedMemoryEntry[];
  memorySuppressedFindings: ValidatedFinding[];
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
    'origin' in finding ? finding.origin : undefined,
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

function isProtectedFinding(finding: ValidatedFinding): boolean {
  return finding.category === 'security' || finding.severity === 'critical' || finding.origin?.kind === 'analyzer';
}

/** Reorders only the already accepted set for bounded inline selection; it never changes summary acceptance. */
export function orderAcceptedFindingsForInline(
  findings: readonly ValidatedFinding[],
  memory?: ReviewMemory,
): ValidatedFinding[] {
  if (!memory || memory.activePreferences.length === 0) return [...findings];
  return [...findings].sort((left, right) => {
    const leftProtected = isProtectedFinding(left);
    const rightProtected = isProtectedFinding(right);
    const protectedOrder = Number(rightProtected) - Number(leftProtected);
    if (protectedOrder !== 0) return protectedOrder;
    if (leftProtected && rightProtected) return compareFindings(left, right);
    return (
      severityRank[left.severity] - severityRank[right.severity] ||
      memoryPreferencePriority(right, memory) - memoryPreferencePriority(left, memory) ||
      compareFindings(left, right)
    );
  });
}

function anchorKey(finding: ReviewFinding): string {
  return `${finding.location.path}\0${finding.location.side}\0${finding.location.line}`;
}

export interface CandidateValidation {
  findings: ValidatedFinding[];
  received: number;
  evidenceRejected: number;
  unmapped: number;
  belowThreshold: number;
}

/** Maps candidates to exact changed lines without deduplication, ranking, or global limiting. */
export function validateReviewCandidates(
  review: ReviewResultV1,
  diff: UnifiedDiff,
  minimumConfidence: number,
  secrets: readonly string[] = [],
  analyzerFindings: readonly AnalyzerFindingCandidate[] = [],
): CandidateValidation {
  if (minimumConfidence < 0 || minimumConfidence > 1) {
    throw new Error('minimumConfidence must be between 0 and 1');
  }
  let evidenceRejected = 0;
  let unmapped = 0;
  let belowThreshold = 0;
  const findings: ValidatedFinding[] = [];
  const candidates: Array<{ finding: ReviewFinding; origin: FindingOrigin; sourceIndex: number }> = [
    ...review.findings.map((finding, sourceIndex) => ({ finding, origin: { kind: 'model' } as const, sourceIndex })),
    ...analyzerFindings.map((finding, index) => ({
      finding,
      origin: finding.origin,
      sourceIndex: review.findings.length + index,
    })),
  ];
  candidates.forEach(({ finding, origin, sourceIndex }) => {
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
      evidenceRejected += 1;
      return;
    }
    if (finding.confidence < minimumConfidence) {
      belowThreshold += 1;
      return;
    }
    const validated = {
      ...finding,
      sourceIndex,
      origin,
      location: { ...finding.location, path: file.apiPath },
      evidence,
      explanation: normalizeLineEndings(finding.explanation).trim(),
      fix: normalizeLineEndings(finding.fix).trim(),
    };
    findings.push({ ...validated, ...fingerprintFinding(validated, diff) });
  });
  return { findings, received: candidates.length, evidenceRejected, unmapped, belowThreshold };
}

/** Maps, deterministically deduplicates, ranks, and limits validated model and analyzer findings. */
export function assessReview(
  review: ReviewResultV1,
  diff: UnifiedDiff,
  policy: FindingPolicy,
  secrets: readonly string[] = [],
  analyzerFindings: readonly AnalyzerFindingCandidate[] = [],
  memory?: ReviewMemory,
): ReviewAssessment {
  if (
    !Number.isInteger(policy.maximumInlineComments) ||
    policy.maximumInlineComments < 0 ||
    policy.maximumInlineComments > 10
  ) {
    throw new Error('maximumInlineComments must be an integer between 0 and 10');
  }
  const validated = validateReviewCandidates(review, diff, policy.minimumConfidence, secrets, analyzerFindings);
  const winners = new Map<string, ValidatedFinding>();
  for (const finding of validated.findings) {
    const key = anchorKey(finding);
    const previous = winners.get(key);
    // Canonical winner selection is fixed review policy and is intentionally independent of repository memory.
    if (!previous || compareFindings(finding, previous) < 0) winners.set(key, finding);
  }
  const canonicalFindings = [...winners.values()];
  const duplicates = validated.findings.length - canonicalFindings.length;
  // Memory is publication policy over canonical independently validated host findings; it never authorizes a candidate.
  const memoryApplication = applyReviewMemory(canonicalFindings, memory);
  const retainedFindings = memoryApplication.findings.sort(compareFindings);
  const findings = retainedFindings.slice(0, 10);
  const globalLimitOmitted = retainedFindings.length - findings.length;
  const rejected = validated.evidenceRejected + globalLimitOmitted;
  const inlineFindings = orderAcceptedFindingsForInline(findings, memory).slice(0, policy.maximumInlineComments);
  const counts: ReviewCounts = {
    received: validated.received,
    accepted: findings.length,
    rejected,
    evidenceRejected: validated.evidenceRejected,
    globalLimitOmitted,
    unmapped: validated.unmapped,
    duplicates,
    belowThreshold: validated.belowThreshold,
    memorySuppressed: memoryApplication.suppressedCount,
    inlineSelected: inlineFindings.length,
    inlineHistorySuppressed: 0,
    inlineLimitOmitted: findings.length - inlineFindings.length,
    inlineOmitted: findings.length - inlineFindings.length,
  };
  if (
    counts.received !==
    counts.accepted +
      counts.rejected +
      counts.unmapped +
      counts.duplicates +
      counts.belowThreshold +
      counts.memorySuppressed
  ) {
    throw new Error('Review assessment counts are inconsistent');
  }
  return {
    modelOutcome: review.outcome,
    findings,
    inlineFindings,
    counts,
    memoryApplications: memoryApplication.appliedEntries,
    memorySuppressedFindings: memoryApplication.suppressedFindings,
  };
}
