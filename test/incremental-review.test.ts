import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assessReview } from '../src/finding-validation';
import type { GitHubCompareResult } from '../src/github';
import { planIncrementalReview } from '../src/incremental-review';
import type { ReviewStateFinding, ReviewStateV1 } from '../src/review-lifecycle';
import { parseUnifiedDiff, prepareReviewedDiff } from '../src/unified-diff';

const baseSha = 'a'.repeat(40);
const priorHead = 'b'.repeat(40);
const currentHead = 'c'.repeat(40);
const fileA = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-oldA();', '+unsafeA();'].join(
  '\n',
);
const fileB = ['diff --git a/b.ts b/b.ts', '--- a/b.ts', '+++ b/b.ts', '@@ -1 +1 @@', '-oldB();', '+newB();'].join(
  '\n',
);
const full = prepareReviewedDiff(`${fileA}\n${fileB}`, 20_000);

function priorFinding(): ReviewStateFinding {
  const finding = assessReview(
    {
      version: 1,
      outcome: 'findings',
      findings: [
        {
          category: 'security',
          severity: 'high',
          confidence: 1,
          location: { path: 'a.ts', side: 'RIGHT', line: 1 },
          evidence: 'unsafeA();',
          explanation: 'Problem.',
          fix: 'Fix.',
        },
      ],
    },
    full.completeParsed,
    { minimumConfidence: 0, maximumInlineComments: 1 },
  ).findings[0]!;
  return {
    fingerprint: finding.fingerprint,
    anchorFingerprint: finding.anchorFingerprint,
    evidenceDigest: finding.evidenceDigest,
    state: 'new',
    category: finding.category,
    severity: finding.severity,
    confidenceBasisPoints: 10_000,
    path: finding.location.path,
    side: finding.location.side,
    line: finding.location.line,
    firstSeenHeadSha: priorHead,
    lastSeenHeadSha: priorHead,
    supersededBy: null,
  };
}

function state(overrides: Partial<ReviewStateV1> = {}): ReviewStateV1 {
  return {
    version: 2,
    apiUrl: 'https://api.github.com',
    repository: 'owner/repository',
    pullRequest: 22,
    backend: 'opencode',
    actorId: 7,
    baseSha,
    headSha: priorHead,
    completedThroughHeadSha: priorHead,
    generation: 1,
    policyDigest: `sha256:${'D'.repeat(43)}`,
    reviewInputDigest: `sha256:${'I'.repeat(43)}`,
    publicationDigest: `sha256:${'E'.repeat(43)}`,
    inlineHistorySuppressed: 0,
    inlineLimitOmitted: 0,
    memory: {
      mode: 'none',
      status: 'disabled',
      effectiveDigest: `sha256:${'M'.repeat(43)}`,
      activeSuppressions: 0,
      activePreferences: 0,
      suppressedCandidates: 0,
      appliedEntries: [],
    },
    coverageComplete: true,
    mode: 'full',
    fromHeadSha: null,
    findings: [priorFinding()],
    ...overrides,
  };
}

function compare(diffText: string, paths: string[]): GitHubCompareResult {
  return {
    status: 'ahead',
    baseSha: priorHead,
    headSha: currentHead,
    mergeBaseSha: priorHead,
    aheadBy: 1,
    behindBy: 0,
    paths,
    diff: parseUnifiedDiff(diffText),
  };
}

test('uses full mode for a new baseline and migration mode only for a legacy summary', () => {
  const first = planIncrementalReview({
    currentDiff: full,
    currentHeadSha: currentHead,
    maximumDiffBytes: 20_000,
    fallbackReason: 'no-managed-summary',
  });
  assert.equal(first.mode, 'full');
  const migration = planIncrementalReview({
    currentDiff: full,
    currentHeadSha: currentHead,
    maximumDiffBytes: 20_000,
    fallbackReason: 'legacy-summary',
  });
  assert.equal(migration.mode, 'migration');
});

test('selects only newly touched current-PR files and carries untouched findings', () => {
  const plan = planIncrementalReview({
    currentDiff: full,
    currentHeadSha: currentHead,
    maximumDiffBytes: 20_000,
    prior: state(),
    compare: compare(fileB, ['b.ts']),
  });
  assert.equal(plan.mode, 'incremental');
  assert.deepEqual(
    plan.diff.parsed.files.map((file) => file.apiPath),
    ['b.ts'],
  );
  assert.equal(plan.carried[0]?.fingerprint, priorFinding().fingerprint);
  assert.deepEqual(plan.affected, []);
});

test('revalidates affected files and never carries a touched prior finding', () => {
  const plan = planIncrementalReview({
    currentDiff: full,
    currentHeadSha: currentHead,
    maximumDiffBytes: 20_000,
    prior: state(),
    compare: compare(fileA, ['a.ts']),
  });
  assert.equal(plan.mode, 'incremental');
  assert.deepEqual(
    plan.diff.parsed.files.map((file) => file.apiPath),
    ['a.ts'],
  );
  assert.equal(plan.affected.length, 1);
  assert.equal(plan.carried.length, 0);
});

test('falls back to the full current diff for force pushes, missing compares, incomplete coverage, and truncated selection', () => {
  for (const input of [
    { prior: state(), fallbackReason: 'force-push' },
    { prior: state({ coverageComplete: false }), compare: compare(fileB, ['b.ts']) },
    { prior: state(), compare: { ...compare(fileA, ['a.ts']), baseSha: 'd'.repeat(40) } },
  ]) {
    const plan = planIncrementalReview({
      currentDiff: full,
      currentHeadSha: currentHead,
      maximumDiffBytes: 20_000,
      ...input,
    });
    assert.equal(plan.mode, 'full');
    assert.equal(plan.diff.text, full.text);
  }
  const truncated = planIncrementalReview({
    currentDiff: full,
    currentHeadSha: currentHead,
    maximumDiffBytes: 20,
    prior: state(),
    compare: compare(fileA, ['a.ts']),
  });
  assert.equal(truncated.mode, 'full');
});

test('review-input mismatch forces a full review even at the same head', () => {
  const plan = planIncrementalReview({
    currentDiff: full,
    currentHeadSha: priorHead,
    maximumDiffBytes: 20_000,
    prior: state(),
    reuseAllowed: false,
    fallbackReason: 'review-input-mismatch',
  });
  assert.equal(plan.mode, 'full');
  assert.equal(plan.reason, 'review-input-mismatch');
  assert.equal(plan.affected.length, 1);
  assert.equal(plan.carried.length, 0);
});

test('same reviewed head skips backend work only when every prior anchor still validates', () => {
  const noChange = planIncrementalReview({
    currentDiff: full,
    currentHeadSha: priorHead,
    maximumDiffBytes: 20_000,
    prior: state(),
  });
  assert.equal(noChange.mode, 'no-change');
  assert.equal(noChange.diff.text, '');
  assert.equal(noChange.carried.length, 1);

  const mismatch = planIncrementalReview({
    currentDiff: full,
    currentHeadSha: priorHead,
    maximumDiffBytes: 20_000,
    prior: state({
      findings: [
        priorFinding(),
        {
          ...priorFinding(),
          fingerprint: `sha256:${'Z'.repeat(43)}`,
          anchorFingerprint: `sha256:${'Y'.repeat(43)}`,
          line: 99,
        },
      ],
    }),
  });
  assert.equal(mismatch.mode, 'full');
});

test('rename comparisons select the authoritative current PR rename and mark prior path affected', () => {
  const renamedCurrent = prepareReviewedDiff(
    [
      'diff --git a/a.ts b/renamed.ts',
      'similarity index 90%',
      'rename from a.ts',
      'rename to renamed.ts',
      '--- a/a.ts',
      '+++ b/renamed.ts',
      '@@ -1 +1 @@',
      '-oldA();',
      '+unsafeA();',
    ].join('\n'),
    20_000,
  );
  const renameCompare = [
    'diff --git a/a.ts b/renamed.ts',
    'similarity index 100%',
    'rename from a.ts',
    'rename to renamed.ts',
  ].join('\n');
  const plan = planIncrementalReview({
    currentDiff: renamedCurrent,
    currentHeadSha: currentHead,
    maximumDiffBytes: 20_000,
    prior: state(),
    compare: compare(renameCompare, ['renamed.ts']),
  });
  assert.equal(plan.mode, 'incremental');
  assert.equal(plan.diff.parsed.files[0]?.apiPath, 'renamed.ts');
  assert.equal(plan.affected.length, 1);
});
