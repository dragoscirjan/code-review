import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assessReview, validateReviewCandidates } from '../src/finding-validation';
import { parseReviewResult, type ReviewFinding, type ReviewResultV1 } from '../src/review-contract';
import { parseUnifiedDiff, prepareReviewedDiff } from '../src/unified-diff';

const diff = parseUnifiedDiff(
  [
    'diff --git a/old.ts b/new.ts',
    'similarity index 90%',
    'rename from old.ts',
    'rename to new.ts',
    '--- a/old.ts',
    '+++ b/new.ts',
    '@@ -1,3 +1,3 @@',
    ' context',
    '-const value = "old";',
    '+const value = "new";',
    ' tail',
  ].join('\n'),
);

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    category: 'correctness',
    severity: 'high',
    confidence: 0.9,
    location: { path: 'new.ts', side: 'RIGHT', line: 2 },
    evidence: 'const value = "new";',
    explanation: ' The value is wrong. ',
    fix: ' Fix it. ',
    ...overrides,
  };
}

function review(findings: ReviewFinding[]) {
  return parseReviewResult(JSON.stringify({ version: 1, outcome: 'findings', findings }));
}

test('accepts exact RIGHT and LEFT anchors and canonicalizes rename publication paths', () => {
  const result = assessReview(
    review([
      finding(),
      finding({ location: { path: 'old.ts', side: 'LEFT', line: 2 }, evidence: 'const value = "old";' }),
    ]),
    diff,
    { minimumConfidence: 0, maximumInlineComments: 10 },
  );
  assert.equal(result.counts.accepted, 2);
  assert.deepEqual(
    result.findings.map((item) => item.location.path),
    ['new.ts', 'new.ts'],
  );
  assert.equal(result.findings[0]?.explanation, 'The value is wrong.');
  for (const accepted of result.findings) {
    assert.match(accepted.anchorFingerprint, /^sha256:[A-Za-z0-9_-]{43}$/u);
    assert.match(accepted.evidenceDigest, /^sha256:[A-Za-z0-9_-]{43}$/u);
    assert.match(accepted.fingerprint, /^sha256:[A-Za-z0-9_-]{43}$/u);
  }
});

test('classifies wrong paths, sides, changed lines, and context-only locations as unmapped', () => {
  const result = assessReview(
    review([
      finding({ location: { path: 'missing.ts', side: 'RIGHT', line: 2 } }),
      finding({ location: { path: 'old.ts', side: 'RIGHT', line: 2 } }),
      finding({ location: { path: 'new.ts', side: 'LEFT', line: 2 } }),
      finding({ location: { path: 'new.ts', side: 'RIGHT', line: 1 }, evidence: 'context' }),
      finding({ location: { path: 'new.ts', side: 'RIGHT', line: 99 } }),
    ]),
    diff,
    { minimumConfidence: 0, maximumInlineComments: 10 },
  );
  assert.equal(result.counts.unmapped, 5);
  assert.equal(result.counts.accepted, 0);
});

test('rejects evidence spoofing, whitespace changes, Unicode substitutions, multiline prose, and secrets', () => {
  const result = assessReview(
    review([
      finding({ evidence: 'const value = "new"' }),
      finding({ evidence: ' const value = "new";' }),
      finding({ evidence: 'const valuе = "new";' }),
      finding({ evidence: 'const value = "new";\ncontext' }),
      finding({ evidence: 'const provider-secret = "new";' }),
    ]),
    diff,
    { minimumConfidence: 0, maximumInlineComments: 10 },
    ['provider-secret'],
  );
  assert.equal(result.counts.rejected, 5);
  assert.equal(result.counts.evidenceRejected, 5);
  assert.equal(result.counts.globalLimitOmitted, 0);
});

test('authorizes suggestions only for explicit safe replacements on exact RIGHT-side lines', () => {
  const result = validateReviewCandidates(
    review([
      finding({ fix: 'suggestion:\n  safe();' }),
      finding({ fix: 'Describe the change in prose.' }),
      finding({
        location: { path: 'old.ts', side: 'LEFT', line: 2 },
        evidence: 'const value = "old";',
        fix: 'suggestion:\nconst value = "older";',
      }),
      finding({ fix: 'suggestion:\nconst value = "new";' }),
      finding({ fix: 'suggestion:\nprovider-secret();' }),
      finding({ fix: 'suggestion:\nsafe();\u202E' }),
      finding({ fix: 'suggestion:\r\nsafe();' }),
    ]),
    diff,
    0,
    ['provider-secret'],
  );

  assert.equal(result.findings.length, 7);
  assert.deepEqual(result.findings[0]?.suggestion, {
    startLine: 2,
    endLine: 2,
    original: 'const value = "new";',
    replacement: '  safe();',
  });
  assert.equal(result.findings[0]?.fix, '  safe();');
  assert.equal(result.findings[1]?.suggestion, undefined);
  assert.equal(result.findings[2]?.suggestion, undefined);
  assert.equal(result.findings[2]?.fix, 'const value = "older";');
  assert.equal(result.findings[3]?.suggestion, undefined);
  assert.equal(result.findings[4]?.suggestion, undefined);
  assert.equal(result.findings[5]?.suggestion, undefined);
  // CRLF never satisfies the literal prefix: the fix stays the normalized prose.
  assert.equal(result.findings[6]?.suggestion, undefined);
  assert.equal(result.findings[6]?.fix, 'suggestion:\nsafe();');

  // Control characters such as ESC (not just format characters) are prose-downgraded. The contract
  // parser already rejects ESC outright for parsed results, so use raw candidates here.
  const raw = validateReviewCandidates(
    {
      version: 1,
      outcome: 'findings',
      findings: [finding({ fix: 'suggestion:\nsafe();\u001B' })],
    } as ReviewResultV1,
    diff,
    0,
  );
  assert.equal(raw.findings[0]?.suggestion, undefined);
  assert.equal(raw.findings[0]?.fix, 'safe();\u001B');
});

test('treats findings in safely omitted truncated hunks as unmapped', () => {
  const first = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n');
  const second = first.replaceAll('a.ts', 'b.ts').replace('+new', `+${'x'.repeat(900)}`);
  const packed = prepareReviewedDiff(`${first}\n${second}`, Buffer.byteLength(first, 'utf8') + 1);
  const result = assessReview(
    review([
      finding({
        location: { path: 'b.ts', side: 'RIGHT', line: 1 },
        evidence: 'x'.repeat(900),
      }),
    ]),
    packed.parsed,
    { minimumConfidence: 0, maximumInlineComments: 10 },
  );
  assert.equal(result.counts.unmapped, 1);
});

test('applies an inclusive confidence threshold and zero/maximum inline limits', () => {
  const atThreshold = assessReview(review([finding({ confidence: 0.8 })]), diff, {
    minimumConfidence: 0.8,
    maximumInlineComments: 0,
  });
  assert.equal(atThreshold.counts.accepted, 1);
  assert.equal(atThreshold.counts.inlineSelected, 0);
  assert.equal(atThreshold.counts.inlineHistorySuppressed, 0);
  assert.equal(atThreshold.counts.inlineLimitOmitted, 1);
  assert.equal(atThreshold.counts.inlineOmitted, 1);

  const below = assessReview(review([finding({ confidence: 0.79 })]), diff, {
    minimumConfidence: 0.8,
    maximumInlineComments: 10,
  });
  assert.equal(below.counts.belowThreshold, 1);
  assert.equal(below.counts.accepted, 0);
});

test('selects the global maximum of ten unique validated findings and reports the omitted remainder', () => {
  const lines = Array.from({ length: 11 }, (_, index) => `line-${index + 1}`);
  const tenLineDiff = parseUnifiedDiff(
    [
      'diff --git a/new.ts b/new.ts',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,11 @@',
      ...lines.map((line) => `+${line}`),
    ].join('\n'),
  );
  const result = assessReview(
    review(
      lines
        .slice(0, 10)
        .map((evidence, index) => finding({ location: { path: 'new.ts', side: 'RIGHT', line: index + 1 }, evidence })),
    ),
    tenLineDiff,
    { minimumConfidence: 0, maximumInlineComments: 10 },
    [],
    [
      {
        ...finding({ location: { path: 'new.ts', side: 'RIGHT', line: 11 }, evidence: 'line-11' }),
        origin: {
          kind: 'analyzer',
          analyzer: 'conflict-markers',
          analyzerVersion: 'code-review-conflict@1.0.0',
          ruleId: 'unresolved-conflict-marker',
          ruleRevision: 1,
          observationDigest: `sha256:${'A'.repeat(43)}`,
        },
      },
    ],
  );
  assert.equal(result.counts.accepted, 10);
  assert.equal(result.counts.inlineSelected, 10);
  assert.equal(result.counts.rejected, 1);
  assert.equal(result.counts.evidenceRejected, 0);
  assert.equal(result.counts.globalLimitOmitted, 1);
});

test('deduplicates by canonical anchor despite category, prose, severity, and confidence variants', () => {
  const result = assessReview(
    review([
      finding({ severity: 'medium', confidence: 1, category: 'testing' }),
      finding({ severity: 'critical', confidence: 0.8, explanation: 'different' }),
      finding({ severity: 'critical', confidence: 0.9, fix: 'different' }),
    ]),
    diff,
    { minimumConfidence: 0, maximumInlineComments: 10 },
  );
  assert.equal(result.counts.duplicates, 2);
  assert.equal(result.counts.accepted, 1);
  assert.equal(result.findings[0]?.severity, 'critical');
  assert.equal(result.findings[0]?.confidence, 0.9);
  assert.equal(
    result.counts.received,
    result.counts.accepted +
      result.counts.rejected +
      result.counts.unmapped +
      result.counts.duplicates +
      result.counts.belowThreshold,
  );
});
