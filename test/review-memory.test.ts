import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assessReview, type ValidatedFinding } from '../src/finding-validation';
import { GitHubClient, type PullRequestContext } from '../src/github';
import type { ReviewFinding } from '../src/review-contract';
import {
  MAX_REVIEW_MEMORY_BYTES,
  REVIEW_MEMORY_PATH,
  applyReviewMemory,
  assertReviewMemoryCurrent,
  disabledReviewMemory,
  loadReviewMemory,
  matchesMemoryPath,
  parseReviewMemory,
  type ReviewMemory,
} from '../src/review-memory';
import { parseUnifiedDiff } from '../src/unified-diff';

const now = new Date('2026-01-01T00:00:00Z');
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const blobSha = 'c'.repeat(40);
const pullRequest: PullRequestContext = {
  owner: 'owner',
  repository: 'repository',
  number: 27,
  baseSha,
  headSha,
  title: 'Change',
  body: '',
  author: 'author',
  url: 'https://example.test/pull/27',
};

function provenance(author = 'maintainer') {
  return { author, kind: 'issue', reference: '#27' } as const;
}

function suppression(overrides: Record<string, unknown> = {}) {
  return {
    id: 'known-false-positive',
    paths: ['src/**/*.ts'],
    scope: { kind: 'category', category: 'correctness' },
    fingerprint: null,
    reason: 'Reviewed and accepted false positive.',
    provenance: provenance(),
    createdAt: '2025-12-01T00:00:00Z',
    expiresAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function preference(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment-focus',
    paths: ['src/payments/**'],
    categories: ['security', 'testing'],
    reason: 'Prioritize payment findings after validation.',
    provenance: provenance('security-team'),
    createdAt: '2025-12-01T00:00:00Z',
    expiresAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function document(suppressions: unknown[] = [suppression()], preferences: unknown[] = [preference()]): string {
  return JSON.stringify({ version: 1, suppressions, preferences });
}

function memory(suppressions: unknown[] = [suppression()], preferences: unknown[] = []): ReviewMemory {
  return parseReviewMemory(document(suppressions, preferences), baseSha, blobSha, now);
}

function finding(overrides: Partial<ValidatedFinding> = {}): ValidatedFinding {
  return {
    category: 'correctness',
    severity: 'high',
    confidence: 0.9,
    location: { path: 'src/deep/file.ts', side: 'RIGHT', line: 1 },
    evidence: 'unsafe();',
    explanation: 'Problem.',
    fix: 'Fix.',
    sourceIndex: 0,
    origin: { kind: 'model' },
    anchorFingerprint: `sha256:${'A'.repeat(43)}`,
    evidenceDigest: `sha256:${'B'.repeat(43)}`,
    fingerprint: `sha256:${'C'.repeat(43)}`,
    ...overrides,
  };
}

const diff = parseUnifiedDiff(
  [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -0,0 +1,2 @@',
    '+alpha();',
    '+beta();',
    'diff --git a/src/payments/z.ts b/src/payments/z.ts',
    '--- a/src/payments/z.ts',
    '+++ b/src/payments/z.ts',
    '@@ -0,0 +1 @@',
    '+pay();',
  ].join('\n'),
);

function review(findings: ReviewFinding[]) {
  return { version: 1, outcome: 'findings', findings } as never;
}

function candidate(
  path: string,
  line: number,
  evidence: string,
  category: 'correctness' | 'security' | 'regression' | 'testing' = 'correctness',
): ReviewFinding {
  return {
    category,
    severity: 'high',
    confidence: 0.9,
    location: { path, side: 'RIGHT', line },
    evidence,
    explanation: 'Problem.',
    fix: 'Fix.',
  };
}

test('strictly parses, canonicalizes, and hashes bounded active repository memory', () => {
  const parsed = memory(
    [suppression({ id: 'z-last', paths: ['src/z.ts', 'src/a.ts'] }), suppression({ id: 'a-first' })],
    [preference()],
  );
  assert.equal(parsed.status, 'enabled');
  assert.deepEqual(
    parsed.activeSuppressions.map((entry) => entry.id),
    ['a-first', 'z-last'],
  );
  assert.deepEqual(parsed.activeSuppressions[1]?.paths, ['src/a.ts', 'src/z.ts']);
  assert.match(parsed.configDigest, /^sha256:[A-Za-z0-9_-]{43}$/u);
  assert.equal(parsed.nextExpiryMs, Date.parse('2026-06-01T00:00:00Z'));
  assert.equal(memory([suppression()], []).effectiveDigest, memory([suppression()], []).effectiveDigest);
});

test('rejects malformed, ambiguous, expired, unsafe, broad-security, and secret-bearing policy', () => {
  const invalid: string[] = [
    '{"version":1,"version":1,"suppressions":[],"preferences":[]}',
    JSON.stringify({ version: 2, suppressions: [], preferences: [] }),
    document([suppression(), suppression()], []),
    document([suppression({ id: 'other' })], [preference({ id: 'other' })]),
    document([suppression({ paths: ['../src/**'] })], []),
    document([suppression({ paths: ['src/**x.ts'] })], []),
    document([suppression({ scope: { kind: 'category', category: 'security' } })], []),
    document([suppression({ expiresAt: '2026-01-01T00:00:00Z' })], []),
    document([suppression({ expiresAt: '2026-01-01T00:00:00+00:00' })], []),
    document([suppression({ createdAt: '2026-02-01T00:00:00Z' })], []),
    document([suppression({ id: 'bad1id' })], []),
    document([suppression({ reason: '\ud800' })], []),
    document([suppression({ reason: 'token-value' })], []),
  ];
  invalid.forEach((raw, index) => {
    assert.throws(
      () => parseReviewMemory(raw, baseSha, blobSha, now, index === invalid.length - 1 ? ['token-value'] : []),
      /memory|Security|Protected|Strict JSON/iu,
      `invalid fixture ${index}`,
    );
  });
  assert.throws(
    () =>
      parseReviewMemory(
        document([suppression({ reason: 'token-value' })], []).replace('token-value', '\\u0074oken-value'),
        baseSha,
        blobSha,
        now,
        ['token-value'],
      ),
    /secret/u,
  );
  assert.throws(
    () => parseReviewMemory('x'.repeat(MAX_REVIEW_MEMORY_BYTES + 1), baseSha, blobSha, now),
    /Strict JSON/u,
  );
});

test('loads only the fixed exact-base path and distinguishes disabled, missing, and unavailable', async () => {
  const calls: unknown[][] = [];
  const client = {
    getRepositoryTextAtRevision: async (...arguments_: unknown[]) => {
      calls.push(arguments_);
      return { status: 'found' as const, text: document([], []), bytes: 1, truncated: false, blobSha };
    },
  };
  const loaded = await loadReviewMemory({ client, pullRequest, mode: 'base-config', reviewStartedAt: now });
  assert.equal(loaded.status, 'enabled');
  assert.deepEqual(calls[0]?.slice(1, 4), [REVIEW_MEMORY_PATH, baseSha, MAX_REVIEW_MEMORY_BYTES]);
  let disabledCalls = 0;
  const disabled = await loadReviewMemory({
    client: { getRepositoryTextAtRevision: async () => (disabledCalls += 1) as never },
    pullRequest,
    mode: 'none',
    reviewStartedAt: now,
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabledCalls, 0);
  const missing = await loadReviewMemory({
    client: {
      getRepositoryTextAtRevision: async () => ({ status: 'not-found', bytes: 0, truncated: false }) as const,
    },
    pullRequest,
    mode: 'base-config',
    reviewStartedAt: now,
  });
  assert.equal(missing.status, 'missing');
  await assert.rejects(
    loadReviewMemory({
      client: {
        getRepositoryTextAtRevision: async () => ({ status: 'unavailable', bytes: 0, truncated: false }) as const,
      },
      pullRequest,
      mode: 'base-config',
      reviewStartedAt: now,
    }),
    /unavailable/u,
  );
});

test('enabled memory consumes only a tree-proven exact-base regular blob', async () => {
  const rootTree = 'd'.repeat(40);
  const githubTree = 'e'.repeat(40);
  const responses = [
    new Response(JSON.stringify({ sha: baseSha, tree: { sha: rootTree } }), { status: 200 }),
    new Response(
      JSON.stringify({
        sha: rootTree,
        truncated: false,
        tree: [{ path: '.github', mode: '040000', type: 'tree', sha: githubTree }],
      }),
      { status: 200 },
    ),
    new Response(
      JSON.stringify({
        sha: githubTree,
        truncated: false,
        tree: [{ path: 'code-review-memory.json', mode: '100644', type: 'blob', sha: blobSha }],
      }),
      { status: 200 },
    ),
    new Response(
      JSON.stringify({ sha: blobSha, encoding: 'base64', content: Buffer.from(document([], [])).toString('base64') }),
      { status: 200 },
    ),
  ];
  const client = new GitHubClient('token', 'https://api.example.test', async () => responses.shift()!);
  const loaded = await loadReviewMemory({ client, pullRequest, mode: 'base-config', reviewStartedAt: now });
  assert.equal(loaded.status, 'enabled');
  assert.equal(loaded.blobSha, blobSha);
  assert.equal(responses.length, 0);
});

test('enabled memory aborts on forbidden exact-base acquisition before review or publication callbacks', async () => {
  let requests = 0;
  let backendCalls = 0;
  let writeCalls = 0;
  const client = new GitHubClient('token', 'https://api.example.test', async () => {
    requests += 1;
    return new Response(null, { status: 403 });
  });
  await assert.rejects(
    (async () => {
      await loadReviewMemory({ client, pullRequest, mode: 'base-config', reviewStartedAt: now });
      backendCalls += 1;
      writeCalls += 1;
    })(),
    /unavailable/u,
  );
  assert.equal(requests, 1);
  assert.equal(backendCalls, 0);
  assert.equal(writeCalls, 0);
});

test('implements bounded case-sensitive segment globs without regex semantics', () => {
  assert.equal(matchesMemoryPath('src/**/*.ts', 'src/file.ts'), true);
  assert.equal(matchesMemoryPath('src/**/*.ts', 'src/a/b.ts'), true);
  assert.equal(matchesMemoryPath('src/?ile.ts', 'src/file.ts'), true);
  assert.equal(matchesMemoryPath('src/*.ts', 'src/a/b.ts'), false);
  assert.equal(matchesMemoryPath('src/*.ts', 'SRC/file.ts'), false);
  assert.equal(matchesMemoryPath('.github/**', '.github/workflows/ci.yml'), true);
  assert.equal(matchesMemoryPath('src/file[.]ts', 'src/file.ts'), false);
  const hostile = `${'*a'.repeat(500)}*`;
  assert.equal(matchesMemoryPath(hostile, 'a'.repeat(500)), true);
});

test('applies one unambiguous suppression after validation and defensively retains security and critical findings', () => {
  const ordinary = finding();
  const security = finding({ category: 'security' });
  const critical = finding({ severity: 'critical' });
  const applied = applyReviewMemory([ordinary, security, critical], memory());
  assert.equal(applied.suppressedCount, 1);
  assert.deepEqual(applied.findings, [security, critical]);
  assert.deepEqual(
    applied.appliedEntries.map((entry) => [entry.id, entry.repositoryDeclaredAuthor]),
    [['known-false-positive', 'maintainer']],
  );
  const exactCritical = memory([
    suppression({
      paths: ['src/deep/file.ts'],
      fingerprint: critical.fingerprint,
    }),
  ]);
  assert.equal(applyReviewMemory([critical], exactCritical).suppressedCount, 1);
  assert.equal(
    applyReviewMemory([{ ...critical, fingerprint: `sha256:${'Q'.repeat(43)}` }], exactCritical).suppressedCount,
    0,
  );
  assert.throws(
    () => applyReviewMemory([ordinary], memory([suppression(), suppression({ id: 'second', paths: ['src/**'] })])),
    /ambiguous/u,
  );
});

test('requires exact selectors for security and immutable analyzer provenance', () => {
  const securityFinding = finding({
    category: 'security',
    location: { path: 'src/security.ts', side: 'RIGHT', line: 1 },
    fingerprint: `sha256:${'S'.repeat(43)}`,
  });
  assert.throws(
    () =>
      memory([
        suppression({
          paths: ['src/*.ts'],
          scope: { kind: 'category', category: 'security' },
          fingerprint: securityFinding.fingerprint,
        }),
      ]),
    /exact fingerprint and exact path/u,
  );
  const exactSecurity = memory([
    suppression({
      paths: ['src/security.ts'],
      scope: { kind: 'category', category: 'security' },
      fingerprint: securityFinding.fingerprint,
    }),
  ]);
  assert.equal(applyReviewMemory([securityFinding], exactSecurity).suppressedCount, 1);
  assert.equal(
    applyReviewMemory(
      [
        {
          ...securityFinding,
          anchorFingerprint: `sha256:${'X'.repeat(43)}`,
          evidenceDigest: `sha256:${'Y'.repeat(43)}`,
          fingerprint: `sha256:${'Z'.repeat(43)}`,
        },
      ],
      exactSecurity,
    ).suppressedCount,
    0,
  );
  assert.equal(
    applyReviewMemory([securityFinding], {
      ...exactSecurity,
      activeSuppressions: [
        {
          ...exactSecurity.activeSuppressions[0]!,
          paths: ['src/*.ts'],
          fingerprint: null,
        },
      ],
    }).suppressedCount,
    0,
  );

  // Analyzer provenance is host-assigned and cannot be replaced by a category selector.

  assert.throws(
    () =>
      memory([
        suppression({
          scope: { kind: 'analyzer-rule', analyzer: 'json-syntax', rule: 'duplicate-property', revision: 1 },
          fingerprint: null,
          paths: ['src/**/*.json'],
        }),
      ]),
    /exact fingerprint/u,
  );
  const analyzerFinding = finding({
    location: { path: 'src/data.json', side: 'RIGHT', line: 1 },
    fingerprint: `sha256:${'D'.repeat(43)}`,
    origin: {
      kind: 'analyzer',
      analyzer: 'json-syntax',
      analyzerVersion: 'code-review-json@1.0.0',
      ruleId: 'duplicate-property',
      ruleRevision: 1,
      observationDigest: `sha256:${'E'.repeat(43)}`,
    },
  });
  const exact = memory([
    suppression({
      paths: ['src/data.json'],
      scope: { kind: 'analyzer-rule', analyzer: 'json-syntax', rule: 'duplicate-property', revision: 1 },
      fingerprint: analyzerFinding.fingerprint,
    }),
  ]);
  const forgedCategoryScope = memory([
    suppression({
      paths: ['src/data.json'],
      scope: { kind: 'category', category: 'correctness' },
      fingerprint: analyzerFinding.fingerprint,
    }),
  ]);
  assert.equal(applyReviewMemory([analyzerFinding], forgedCategoryScope).suppressedCount, 0);
  assert.equal(applyReviewMemory([analyzerFinding], exact).suppressedCount, 1);
  assert.equal(
    applyReviewMemory([{ ...analyzerFinding, fingerprint: `sha256:${'F'.repeat(43)}` }], exact).suppressedCount,
    0,
  );
  assert.equal(
    applyReviewMemory(
      [
        {
          ...analyzerFinding,
          origin: {
            kind: 'analyzer',
            analyzer: 'json-syntax',
            analyzerVersion: 'code-review-json@1.0.0',
            ruleId: 'syntax-error',
            ruleRevision: 1,
            observationDigest: `sha256:${'G'.repeat(43)}`,
          },
        },
      ],
      exact,
    ).suppressedCount,
    0,
  );
});

test('production assessment validates and canonically deduplicates before memory without promoting variants', () => {
  const suppressionMemory = memory([suppression({ paths: ['src/a.ts'] })]);
  const assessed = assessReview(
    review([
      candidate('src/a.ts', 1, 'alpha();'),
      candidate('src/a.ts', 99, 'wrong'),
      { ...candidate('src/a.ts', 2, 'beta();'), confidence: 0.1 },
    ]),
    diff,
    { minimumConfidence: 0.5, maximumInlineComments: 10 },
    [],
    [],
    suppressionMemory,
  );
  assert.equal(assessed.counts.memorySuppressed, 1);
  assert.equal(assessed.counts.unmapped, 1);
  assert.equal(assessed.counts.belowThreshold, 1);
  assert.equal(assessed.counts.received, 3);
  assert.equal(assessed.findings.length, 0);

  const sameAnchor = assessReview(
    review([
      candidate('src/a.ts', 1, 'alpha();'),
      { ...candidate('src/a.ts', 1, 'alpha();', 'regression'), severity: 'medium' },
    ]),
    diff,
    { minimumConfidence: 0, maximumInlineComments: 10 },
    [],
    [],
    suppressionMemory,
  );
  assert.equal(sameAnchor.counts.duplicates, 1);
  assert.equal(sameAnchor.counts.memorySuppressed, 1);
  assert.equal(sameAnchor.findings.length, 0);

  const preferenceMemory = memory([], [preference({ paths: ['src/payments/**'], categories: ['correctness'] })]);
  const ordered = assessReview(
    review([candidate('src/a.ts', 1, 'alpha();'), candidate('src/payments/z.ts', 1, 'pay();')]),
    diff,
    { minimumConfidence: 0, maximumInlineComments: 10 },
    [],
    [],
    preferenceMemory,
  );
  assert.equal(ordered.findings[0]?.location.path, 'src/a.ts');
  assert.equal(ordered.inlineFindings[0]?.location.path, 'src/payments/z.ts');
  assert.equal(
    ordered.findings.every((entry) => entry.confidence === 0.9),
    true,
  );
});

test('preferences preserve the global accepted set and cannot displace protected inline findings', () => {
  const manyDiff = parseUnifiedDiff(
    Array.from({ length: 12 }, (_value, index) => {
      const path = `src/${String(index).padStart(2, '0')}.ts`;
      return [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+line${index}();`,
      ].join('\n');
    }).join('\n'),
  );
  const candidates = Array.from({ length: 12 }, (_value, index) =>
    candidate(`src/${String(index).padStart(2, '0')}.ts`, 1, `line${index}();`),
  );
  const baseline = assessReview(review(candidates), manyDiff, { minimumConfidence: 0, maximumInlineComments: 3 });
  const preferred = assessReview(
    review(candidates),
    manyDiff,
    { minimumConfidence: 0, maximumInlineComments: 3 },
    [],
    [],
    memory([], [preference({ paths: ['src/11.ts'], categories: ['correctness'] })]),
  );
  assert.deepEqual(
    preferred.findings.map((entry) => entry.fingerprint),
    baseline.findings.map((entry) => entry.fingerprint),
  );
  assert.equal(preferred.counts.globalLimitOmitted, 2);
  assert.equal(
    preferred.findings.some((entry) => entry.location.path === 'src/11.ts'),
    false,
  );

  const protectedDiff = parseUnifiedDiff(
    [
      'diff --git a/src/critical.ts b/src/critical.ts',
      '--- a/src/critical.ts',
      '+++ b/src/critical.ts',
      '@@ -0,0 +1 @@',
      '+critical();',
      'diff --git a/src/security.ts b/src/security.ts',
      '--- a/src/security.ts',
      '+++ b/src/security.ts',
      '@@ -0,0 +1 @@',
      '+security();',
      'diff --git a/src/analyzer.json b/src/analyzer.json',
      '--- a/src/analyzer.json',
      '+++ b/src/analyzer.json',
      '@@ -0,0 +1 @@',
      '+{"a":1,"a":2}',
      'diff --git a/src/payments/preferred.ts b/src/payments/preferred.ts',
      '--- a/src/payments/preferred.ts',
      '+++ b/src/payments/preferred.ts',
      '@@ -0,0 +1 @@',
      '+preferred();',
    ].join('\n'),
  );
  const protectedAssessment = assessReview(
    review([
      { ...candidate('src/critical.ts', 1, 'critical();'), severity: 'critical' },
      { ...candidate('src/security.ts', 1, 'security();', 'security'), severity: 'medium' },
      candidate('src/payments/preferred.ts', 1, 'preferred();'),
    ]),
    protectedDiff,
    { minimumConfidence: 0, maximumInlineComments: 3 },
    [],
    [
      {
        ...candidate('src/analyzer.json', 1, '{"a":1,"a":2}'),
        severity: 'low',
        origin: {
          kind: 'analyzer',
          analyzer: 'json-syntax',
          analyzerVersion: 'code-review-json@1.0.0',
          ruleId: 'duplicate-property',
          ruleRevision: 1,
          observationDigest: `sha256:${'O'.repeat(43)}`,
        },
      },
    ],
    memory([], [preference({ paths: ['src/payments/**'], categories: ['correctness'] })]),
  );
  assert.equal(protectedAssessment.findings.length, 4);
  assert.deepEqual(
    protectedAssessment.inlineFindings.map((entry) => entry.location.path),
    ['src/critical.ts', 'src/security.ts', 'src/analyzer.json'],
  );

  const analyzerCandidate = {
    ...candidate('src/analyzer.json', 1, '{"a":1,"a":2}'),
    severity: 'high' as const,
    origin: {
      kind: 'analyzer' as const,
      analyzer: 'json-syntax' as const,
      analyzerVersion: 'code-review-json@1.0.0',
      ruleId: 'duplicate-property' as const,
      ruleRevision: 1,
      observationDigest: `sha256:${'P'.repeat(43)}`,
    },
  };
  const equalProtectedReview = review([
    { ...candidate('src/security.ts', 1, 'security();', 'security'), severity: 'high' },
  ]);
  const protectedBaseline = assessReview(
    equalProtectedReview,
    protectedDiff,
    { minimumConfidence: 0, maximumInlineComments: 1 },
    [],
    [analyzerCandidate],
  );
  const protectedPreferred = assessReview(
    equalProtectedReview,
    protectedDiff,
    { minimumConfidence: 0, maximumInlineComments: 1 },
    [],
    [analyzerCandidate],
    memory([], [preference({ paths: ['src/security.ts'], categories: ['security'] })]),
  );
  assert.equal(protectedBaseline.inlineFindings[0]?.location.path, 'src/analyzer.json');
  assert.equal(protectedPreferred.inlineFindings[0]?.fingerprint, protectedBaseline.inlineFindings[0]?.fingerprint);
  assert.deepEqual(
    protectedPreferred.findings.map((entry) => entry.fingerprint),
    protectedBaseline.findings.map((entry) => entry.fingerprint),
  );
});

test('expiry is checked again before publication rather than lingering through a long review', () => {
  const configured = memory();
  assert.doesNotThrow(() => assertReviewMemoryCurrent(configured, new Date('2026-05-31T23:59:59Z')));
  assert.throws(() => assertReviewMemoryCurrent(configured, new Date('2026-06-01T00:00:00Z')), /expired/u);
  assert.equal(disabledReviewMemory(baseSha).nextExpiryMs, null);
});
