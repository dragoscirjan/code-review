import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderComment, renderProgressComment } from '../src/comment';
import { assessReview, type ReviewAssessment } from '../src/finding-validation';
import type { ValidatedFinding } from '../src/finding-validation';
import type { ReviewFinding } from '../src/review-contract';
import type { ReviewExecutionSummary } from '../src/review-specialists';
import { prepareReviewedDiff } from '../src/unified-diff';

const diff = prepareReviewedDiff(
  [
    'diff --git a/src/file.ts b/src/file.ts',
    '--- a/src/file.ts',
    '+++ b/src/file.ts',
    '@@ -1 +1 @@',
    '-old();',
    '+unsafe();',
  ].join('\n'),
  10_000,
);

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    category: 'correctness',
    severity: 'high',
    confidence: 0.9,
    location: { path: 'src/file.ts', side: 'RIGHT', line: 1 },
    evidence: 'unsafe();',
    explanation: 'Unsafe behavior.',
    fix: 'Use safe behavior.',
    ...overrides,
  };
}

function provisionalAssessment(findings: readonly ReviewFinding[]): ReviewAssessment {
  const base = assessReview(
    { version: 1, outcome: findings.length === 0 ? 'clean' : 'findings', findings: findings.slice() as never },
    diff.parsed!,
    { minimumConfidence: 0, maximumInlineComments: 0 },
    [],
    [],
  );
  return base;
}

const marker = '<!-- code-review:pi:v6 -->';

test('progress summary shows running status, shard counts, and collapsible provisional findings', () => {
  const body = renderProgressComment({
    assessment: provisionalAssessment([]),
    backend: 'pi',
    model: 'm',
    headSha: 'b'.repeat(40),
    actor: 'reviewer',
    completedShards: 2,
    totalShards: 5,
    provisionalFindings: [],
    marker,
  });
  assert.match(body, /👀 Review in progress/u);
  assert.match(body, /shards completed 2 \/ 5/u);
  assert.ok(body.trimEnd().endsWith(marker));
  assert.ok(Buffer.byteLength(body, 'utf8') <= 65_536);

  const withFindings = renderProgressComment({
    assessment: provisionalAssessment([]),
    backend: 'pi',
    model: 'm',
    headSha: 'b'.repeat(40),
    actor: 'reviewer',
    completedShards: 3,
    totalShards: 5,
    provisionalFindings: [finding(), finding({ category: 'security', severity: 'critical' })] as ValidatedFinding[],
    marker,
  });
  assert.match(withFindings, /<details>/u);
  assert.match(
    withFindings,
    /<summary>🟠 High 🎯 Correctness — <pre><code>src\/file\.ts<\/code><\/pre>:1 \(RIGHT\)<\/summary>/u,
  );
  assert.ok(withFindings.indexOf('<details>') < withFindings.indexOf('Unsafe behavior.'));
});

test('progress summary drops oldest provisional findings to stay within the comment limit', () => {
  const wide = 'x'.repeat(20_000);
  const many = Array.from({ length: 12 }, (_, index) =>
    finding({ explanation: `${wide} ${index}`, evidence: 'unsafe();' }),
  );
  const body = renderProgressComment({
    assessment: provisionalAssessment([]),
    backend: 'pi',
    model: 'm',
    headSha: 'b'.repeat(40),
    actor: 'reviewer',
    completedShards: 4,
    totalShards: 5,
    provisionalFindings: many as ValidatedFinding[],
    marker,
  });
  assert.ok(Buffer.byteLength(body, 'utf8') <= 65_536);
  assert.match(body, /omitted to fit the GitHub comment limit/u);
  assert.ok(body.trimEnd().endsWith(marker));
});

test('degraded final comment renders the coverage statement and keeps findings', () => {
  const summary = {
    plan: {
      version: 2 as const,
      requested: 'specialists' as const,
      selected: 'sharded' as const,
      reasons: ['forced-sharded'],
    },
    rolesAttempted: 2,
    rolesCompleted: 2,
    arbiterRan: false,
    rawCandidateCount: 3,
    validatedCandidateCount: 2,
    preArbiterOmittedCount: 0,
    arbiterRejectedCount: 0,
    reservedTokens: 1_000,
    degraded: true,
    notCoveredShards: 3,
  } satisfies ReviewExecutionSummary;
  const assessment = provisionalAssessment([finding()]);
  const body = renderComment({
    assessment,
    backend: 'pi',
    model: 'm',
    headSha: 'b'.repeat(40),
    actor: 'reviewer',
    diffTruncated: false,
    originalDiffBytes: 100,
    executionSummary: summary,
    coverage: { degraded: true, notCoveredShards: 3, totalShards: 5, provisionalFindings: 2 },
    marker,
  });
  assert.match(body, /Partial review/u);
  assert.match(body, /3 of 5 diff shards were not reviewed/u);
  assert.match(body, /not confirmed by the final merge pass/u);
  assert.match(body, /Unsafe behavior\./u);
});

test('complete runs render no coverage statement', () => {
  const summary = {
    plan: {
      version: 2 as const,
      requested: 'specialists' as const,
      selected: 'sharded' as const,
      reasons: ['forced-sharded'],
    },
    rolesAttempted: 3,
    rolesCompleted: 3,
    arbiterRan: true,
    rawCandidateCount: 1,
    validatedCandidateCount: 1,
    preArbiterOmittedCount: 0,
    arbiterRejectedCount: 0,
    reservedTokens: 1_000,
  } satisfies ReviewExecutionSummary;
  const body = renderComment({
    assessment: provisionalAssessment([finding()]),
    backend: 'pi',
    model: 'm',
    headSha: 'b'.repeat(40),
    actor: 'reviewer',
    diffTruncated: false,
    originalDiffBytes: 100,
    executionSummary: summary,
    marker,
  });
  assert.doesNotMatch(body, /Partial review/u);
});

test('deterministic phase-0 findings render in the progress summary', () => {
  const assessment = assessReview(
    { version: 1, outcome: 'clean', findings: [] },
    diff.parsed!,
    { minimumConfidence: 0, maximumInlineComments: 0 },
    [],
    [],
  );
  const body = renderProgressComment({
    assessment,
    backend: 'pi',
    model: 'm',
    headSha: 'b'.repeat(40),
    actor: 'reviewer',
    completedShards: 0,
    totalShards: 4,
    provisionalFindings: [],
    marker,
  });
  assert.match(body, /👋 Hola! We're doing code review, yo! Have a bit of patience!/u);
  assert.doesNotMatch(body, /Review in progress/u);
});
