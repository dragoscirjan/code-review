import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_GITHUB_COMMENT_BYTES, renderComment, renderInlineComment } from '../src/comment';
import type { ReviewAssessment, ValidatedFinding } from '../src/finding-validation';
import { publicationDigest, serializeReviewState } from '../src/review-lifecycle';

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
    anchorFingerprint: `sha256:${'a'.repeat(43)}`,
    evidenceDigest: `sha256:${'b'.repeat(43)}`,
    fingerprint: `sha256:${'c'.repeat(43)}`,
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
      evidenceRejected: 0,
      globalLimitOmitted: 0,
      unmapped: 0,
      duplicates: 0,
      belowThreshold: 0,
      memorySuppressed: 0,
      inlineSelected: findings.length,
      inlineHistorySuppressed: 0,
      inlineLimitOmitted: 0,
      inlineOmitted: 0,
    },
    memoryApplications: [],
    memorySuppressedFindings: [],
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
    assert.match(comment, /No validated findings were returned for the supplied context/i);
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
    contextMetadata: {
      version: 1,
      maximumBytes: 50_000,
      includedBytes: 12_345,
      truncated: true,
      unavailableSourceCount: 2,
      truncatedSourceCount: 1,
      anchorsPlanned: 3,
      queriesPlanned: 12,
      queriesCompleted: 8,
      queriesTimedOut: 1,
      queryByteLimitHits: 1,
      queryBudgetSkipped: 3,
      indexer: 'cgc',
      guidance: { agents: 'included', contributing: 'unavailable' },
      configuration: { candidates: 2, included: 1, unavailable: 1, truncated: 0 },
      linkedIssues: { discovered: 2, fetched: 1, unavailable: 1 },
    },
    marker: '<!-- managed -->',
  });
  assert.match(comment, /Review context: 12345 \/ 50000 bytes/);
  assert.match(comment, /Context sources unavailable: 2/);
  assert.match(comment, /Base configuration: 1 included, 1 unavailable, 0 truncated/);
  assert.match(comment, /Context queries: 8 completed, 1 timed out, 3 skipped by budget/);
  assert.match(comment, /Linked issue criteria: 1 included, 1 unavailable/);
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

test('renders only host-generated specialist execution metadata', () => {
  const comment = renderComment({
    assessment: assessment([], 'clean'),
    backend: 'opencode',
    model: 'model',
    headSha: '1'.repeat(40),
    actor: 'reviewer',
    diffTruncated: false,
    originalDiffBytes: 1,
    executionSummary: {
      plan: { version: 2, requested: 'auto', selected: 'sharded', reasons: ['sensitive-surface'] },
      rolesAttempted: 2,
      rolesCompleted: 2,
      arbiterRan: true,
      rawCandidateCount: 2,
      validatedCandidateCount: 1,
      preArbiterOmittedCount: 0,
      arbiterRejectedCount: 1,
      reservedTokens: 123_456,
    },
    marker: '<!-- managed -->',
  });
  assert.match(comment, /Requested review strategy: auto/u);
  assert.match(comment, /Selected review strategy: sharded/u);
  assert.match(comment, /Strategy reasons: sensitive-surface/u);
  assert.match(comment, /Review passes completed: 2/u);
  assert.match(comment, /Candidates rejected by arbiter: 1/u);
  assert.match(comment, /Reserved specialist token units: 123456/u);
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

test('renders validated replacements as collision-safe GitHub suggestion blocks', () => {
  const comment = renderInlineComment(
    finding({
      fix: 'const marker = "```";',
      suggestion: {
        startLine: 3,
        endLine: 3,
        original: 'unsafe();',
        replacement: 'const marker = "```";',
      },
    }),
    '<!-- inline -->',
  );

  assert.match(comment, /````suggestion\nconst marker = "```";\n````/u);
  assert.doesNotMatch(comment, /\*\*Suggested fix:\*\*/u);
  assert.equal(comment.trimEnd().split(/\r?\n/u).at(-1), '<!-- inline -->');
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

test('keeps mandatory lifecycle metadata and final ownership marker under detail size pressure', () => {
  const findings = Array.from({ length: 10 }, (_, index) =>
    finding({
      sourceIndex: index,
      fingerprint: `sha256:${String.fromCharCode(65 + index).repeat(43)}`,
      anchorFingerprint: `sha256:${String.fromCharCode(75 + index).repeat(43)}`,
      evidenceDigest: `sha256:${String.fromCharCode(85 + index).repeat(43)}`,
      location: { path: `src/${index}.ts`, side: 'RIGHT', line: index + 1 },
      evidence: '&'.repeat(1_000),
      explanation: '&'.repeat(1_000),
      fix: '&'.repeat(2_000),
    }),
  );
  const stateLine = serializeReviewState({
    version: 2,
    apiUrl: 'https://api.github.com',
    repository: 'owner/repository',
    pullRequest: 22,
    backend: 'opencode',
    actorId: 7,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    completedThroughHeadSha: 'b'.repeat(40),
    generation: 1,
    policyDigest: `sha256:${'D'.repeat(43)}`,
    reviewInputDigest: `sha256:${'I'.repeat(43)}`,
    publicationDigest: publicationDigest({
      repository: 'owner/repository',
      pullRequest: 22,
      backend: 'opencode',
      actorId: 7,
      headSha: 'b'.repeat(40),
      fingerprints: [],
    }),
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
    findings: [],
  });
  const marker = '<!-- code-review:opencode:v5 -->';
  const comment = renderComment({
    assessment: assessment(findings),
    backend: 'opencode',
    model: 'm'.repeat(200),
    headSha: 'b'.repeat(40),
    actor: 'a'.repeat(39),
    diffTruncated: false,
    originalDiffBytes: 1,
    lifecycle: {
      mode: 'full',
      reason: 'baseline',
      fromHeadSha: null,
      counts: { new: 10, unchanged: 0, resolved: 0, superseded: 0 },
      active: [],
      tombstones: [],
      stateLine,
    },
    marker,
  });
  assert.ok(Buffer.byteLength(comment, 'utf8') <= MAX_GITHUB_COMMENT_BYTES);
  const lines = comment.trimEnd().split(/\r?\n/u);
  assert.equal(lines.at(-2), stateLine);
  assert.equal(lines.at(-1), marker);
  assert.match(comment, /detailed finding block/u);
});
