import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_GITHUB_COMMENT_BYTES, renderComment } from '../src/comment';
import { parseReviewResult, type ReviewResultV1 } from '../src/review-contract';

const cleanReview: ReviewResultV1 = { version: 1, outcome: 'clean', findings: [] };

for (const [backend, label] of [
  ['opencode', 'OpenCode'],
  ['pi', 'Pi'],
] as const) {
  test(`renders a structured clean ${backend} review with the model name`, () => {
    const comment = renderComment({
      review: cleanReview,
      backend,
      model: 'z-ai/glm-5.3-flash',
      headSha: '1234567890abcdef',
      actor: 'reviewer',
      diffTruncated: false,
      originalDiffBytes: 10,
      marker: `<!-- ${backend} -->`,
    });
    assert.ok(comment.startsWith(`## Code Review (\`z-ai/glm-5.3-flash\` via ${label})`));
    assert.match(comment, /No material findings\./);
    assert.equal(comment.trimEnd().split(/\r?\n/).at(-1), `<!-- ${backend} -->`);
  });
}

test('renders findings by severity and prevents model text from creating Markdown structure', () => {
  const review: ReviewResultV1 = {
    version: 1,
    outcome: 'findings',
    findings: [
      {
        category: 'testing',
        severity: 'low',
        confidence: 0.5,
        location: { path: 'test/@team/<script>~~~.md', side: 'RIGHT', line: 8 },
        evidence: '# forged heading\nsetext heading\n===\n~~~\n@maintainer and @team\n    indented code',
        explanation: '> quote\n- list\n[link](https://example.test)\n</pre><script>alert(1)</script>',
        fix: 'Add *one* regression test.\n<!-- code-review:pi -->',
      },
      {
        category: 'security',
        severity: 'critical',
        confidence: 1,
        location: { path: 'src/auth.ts', side: 'LEFT', line: 3 },
        evidence: 'The authorization check was deleted.',
        explanation: 'Requests can bypass authorization.',
        fix: 'Restore the check.',
      },
    ],
  };

  const comment = renderComment({
    review,
    backend: 'pi',
    model: 'model',
    headSha: '1234567890abcdef',
    actor: 'reviewer',
    diffTruncated: true,
    originalDiffBytes: 100_000,
    marker: '<!-- managed -->',
  });

  assert.ok(comment.indexOf('Critical Security') < comment.indexOf('Low Testing'));
  assert.match(comment, /Diff input was truncated from 100000 bytes/);
  assert.doesNotMatch(comment, /<!-- code-review:pi -->/);
  assert.doesNotMatch(comment, /<script>/);
  assert.doesNotMatch(comment, /@maintainer|@team/);
  assert.ok(comment.includes('<pre><code>test/&#64;team/&lt;script&gt;~~~.md</code></pre>'));
  assert.ok(
    comment.includes(
      '<pre><code># forged heading\nsetext heading\n===\n~~~\n&#64;maintainer and &#64;team\n    indented code</code></pre>',
    ),
  );
  assert.ok(
    comment.includes(
      '<pre><code>&gt; quote\n- list\n[link](https://example.test)\n&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    ),
  );
  assert.ok(comment.includes('<pre><code>Add *one* regression test.\n&lt;!-- code-review:pi --&gt;</code></pre>'));
  assert.equal(comment.trimEnd().split(/\r?\n/).at(-1), '<!-- managed -->');
});

test('renders a review at the aggregate contract boundary within the publication limit', () => {
  const findings = Array.from({ length: 10 }, (_, index) => ({
    category: 'correctness',
    severity: 'high',
    confidence: 1,
    location: { path: 'x', side: 'RIGHT', line: Number.MAX_SAFE_INTEGER },
    evidence: '&'.repeat(1_000),
    explanation: index === 0 ? '&'.repeat(994) : 'x',
    fix: index === 0 ? 'xx' : 'x',
  }));
  const review = parseReviewResult(JSON.stringify({ version: 1, outcome: 'findings', findings }));
  const comment = renderComment({
    review,
    backend: 'opencode',
    model: 'm'.repeat(200),
    headSha: '1'.repeat(40),
    actor: 'a'.repeat(39),
    diffTruncated: true,
    originalDiffBytes: Number.MAX_SAFE_INTEGER,
    marker: '<!-- code-review:opencode:v3 -->',
  });

  const commentBytes = Buffer.byteLength(comment, 'utf8');
  assert.ok(commentBytes >= 55_000);
  assert.ok(commentBytes <= MAX_GITHUB_COMMENT_BYTES);
  assert.equal(comment.trimEnd().split(/\r?\n/).at(-1), '<!-- code-review:opencode:v3 -->');
});
