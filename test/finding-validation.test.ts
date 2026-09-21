import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assessReview } from '../src/finding-validation';
import { parseReviewResult, type ReviewFinding } from '../src/review-contract';
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

test('selects the configured maximum of ten unique validated inline findings', () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`);
  const tenLineDiff = parseUnifiedDiff(
    [
      'diff --git a/new.ts b/new.ts',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,10 @@',
      ...lines.map((line) => `+${line}`),
    ].join('\n'),
  );
  const result = assessReview(
    review(
      lines.map((evidence, index) =>
        finding({ location: { path: 'new.ts', side: 'RIGHT', line: index + 1 }, evidence }),
      ),
    ),
    tenLineDiff,
    { minimumConfidence: 0, maximumInlineComments: 10 },
  );
  assert.equal(result.counts.accepted, 10);
  assert.equal(result.counts.inlineSelected, 10);
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
