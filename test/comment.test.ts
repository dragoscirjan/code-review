import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_GITHUB_COMMENT_BYTES, renderComment, renderInlineComment } from '../src/comment';
import type { ReviewAssessment, ValidatedFinding } from '../src/finding-validation';

function finding(overrides: Partial<ValidatedFinding> = {}): ValidatedFinding {
  return {
    category: 'security',
    severity: 'critical',
    confidence: 1,
    location: { path: 'src/auth.ts', side: 'RIGHT', line: 3 },
    evidence: 'unsafe();',
    explanation: 'Requests bypass authorization.',
    fix: 'Restore the check.',
    sourceIndex: 0,
    ...overrides,
  };
}

function assessment(
  findings: ValidatedFinding[] = [],
  modelOutcome: 'clean' | 'findings' = 'findings',
): ReviewAssessment {
  return {
    modelOutcome,
    findings,
    inlineFindings: findings,
    counts: {
      received: findings.length,
      accepted: findings.length,
      rejected: 0,
      unmapped: 0,
      duplicates: 0,
      belowThreshold: 0,
      inlineSelected: findings.length,
      inlineOmitted: 0,
    },
  };
}

for (const [backend, label] of [
  ['opencode', 'OpenCode'],
  ['pi', 'Pi'],
] as const) {
  test(`renders a structured clean ${backend} review with validation counts`, () => {
    const comment = renderComment({
      assessment: assessment([], 'clean'),
      backend,
      model: 'z-ai/glm-5.3-flash',
      headSha: '1234567890abcdef',
      actor: 'reviewer',
      diffTruncated: false,
      originalDiffBytes: 10,
      marker: `<!-- ${backend} -->`,
    });
    assert.ok(comment.startsWith(`## Code Review (\`z-ai/glm-5.3-flash\` via ${label})`));
    assert.match(comment, /reviewer returned no findings/i);
    assert.match(comment, /Accepted: 0/);
    assert.equal(comment.trimEnd().split(/\r?\n/).at(-1), `<!-- ${backend} -->`);
  });
}

test('renders accepted counts and keeps Markdown, HTML, mentions, bidi, and markers inert', () => {
  const hostile = finding({
    location: { path: 'test/@team/<script>\u061C.ts', side: 'RIGHT', line: 8 },
    evidence: '# forged heading\u206A',
    explanation: '> quote\n- list\n@team\n\u202Eevil\u206F\n</pre><script>alert(1)</script>',
    fix: '~~~\u200B\n<!-- code-review:pi -->',
  });
  const result = assessment([hostile]);
  result.counts.received = 5;
  result.counts.rejected = 1;
  result.counts.unmapped = 1;
  result.counts.duplicates = 1;
  result.counts.belowThreshold = 1;
  const comment = renderComment({
    assessment: result,
    backend: 'pi',
    model: 'model',
    headSha: '1234567890abcdef',
    actor: 'reviewer',
    diffTruncated: true,
    originalDiffBytes: 100_000,
    marker: '<!-- managed -->',
  });
  assert.match(comment, /Rejected .*: 1/);
  assert.match(comment, /Unmapped: 1/);
  assert.match(comment, /Duplicates removed: 1/);
  assert.match(comment, /Below confidence threshold: 1/);
  assert.match(comment, /complete diff-hunk boundaries/);
  assert.doesNotMatch(comment, /<script>/);
  assert.doesNotMatch(comment, /@team/);
  for (const code of ['061C', '200B', '202E', '206A', '206F']) assert.ok(comment.includes(`\\u{${code}}`));
  assert.doesNotMatch(comment, /[\u061C\u200B\u202E\u206A\u206F]/u);
  assert.equal(comment.trimEnd().split(/\r?\n/).at(-1), '<!-- managed -->');
});

test('renders a bounded inline comment with all format controls visible and the deterministic marker last', () => {
  const comment = renderInlineComment(
    finding({
      location: { path: 'src/\u061Cauth.ts', side: 'RIGHT', line: 3 },
      evidence: 'unsafe();\u206A',
      explanation: 'explain\u206F',
      fix: 'fix\u200B',
    }),
    '<!-- inline -->',
  );
  assert.match(comment, /Critical Security/);
  for (const code of ['061C', '200B', '206A', '206F']) assert.ok(comment.includes(`\\u{${code}}`));
  assert.doesNotMatch(comment, /[\u061C\u200B\u206A\u206F]/u);
  assert.equal(comment.trimEnd().split(/\r?\n/).at(-1), '<!-- inline -->');
  assert.ok(Buffer.byteLength(comment, 'utf8') <= MAX_GITHUB_COMMENT_BYTES);
});

test('renders accepted findings near the contract aggregate boundary within the publication limit', () => {
  const findings = Array.from({ length: 10 }, (_, index) =>
    finding({
      sourceIndex: index,
      location: { path: 'x', side: 'RIGHT', line: index + 1 },
      evidence: '&'.repeat(1_000),
      explanation: index === 0 ? '&'.repeat(994) : 'x',
      fix: index === 0 ? 'xx' : 'x',
    }),
  );
  const comment = renderComment({
    assessment: assessment(findings),
    backend: 'opencode',
    model: 'm'.repeat(200),
    headSha: '1'.repeat(40),
    actor: 'a'.repeat(39),
    diffTruncated: true,
    originalDiffBytes: Number.MAX_SAFE_INTEGER,
    marker: '<!-- code-review:opencode:v4 -->',
  });
  assert.ok(Buffer.byteLength(comment, 'utf8') <= MAX_GITHUB_COMMENT_BYTES);
});
