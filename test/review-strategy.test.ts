import assert from 'node:assert/strict';
import { test } from 'vitest';
import { packReviewContext, serializeReviewContext, type ContextRuntimeSummary } from '../src/context-planner';
import type { ReviewStateFinding } from '../src/review-lifecycle';
import {
  MAX_ARBITER_CONTEXT_BYTES,
  MAX_SPECIALIST_CONTEXT_BYTES,
  SPECIALIST_ROLES,
  arbiterOutputTokens,
  priorFindingsForRole,
  projectArbiterContext,
  projectReviewContextForRole,
  reserveSpecialistTokens,
  selectReviewStrategy,
  specialistOutputTokens,
} from '../src/review-strategy';
import { prepareReviewedDiff } from '../src/unified-diff';

const runtime: ContextRuntimeSummary = {
  indexer: 'gitnexus',
  anchorsPlanned: 1,
  queriesPlanned: 4,
  queriesCompleted: 4,
  queriesTimedOut: 0,
  queryByteLimitHits: 0,
  queryBudgetSkipped: 0,
  guidance: { agents: 'included', contributing: 'included' },
  configuration: { candidates: 1, included: 1, unavailable: 0, truncated: 0 },
  linkedIssues: { discovered: 1, fetched: 1, unavailable: 0 },
};

function oneFile(path = 'src/value.ts', additions = 1) {
  const added = Array.from({ length: additions }, (_, index) => `+const value${index} = ${index};`);
  return prepareReviewedDiff(
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -0,0 +1,${additions} @@`, ...added].join(
      '\n',
    ),
    500_000,
  );
}

test('forced and auto strategies use fixed deterministic threshold reasons', () => {
  const low = oneFile();
  assert.deepEqual(selectReviewStrategy({ requested: 'auto', diff: low, analyzerCoverage: 'complete' }), {
    version: 1,
    requested: 'auto',
    selected: 'single-pass',
    reasons: ['low-risk'],
  });
  assert.deepEqual(selectReviewStrategy({ requested: 'single-pass', diff: low, analyzerCoverage: 'partial' }).reasons, [
    'forced-single-pass',
  ]);
  assert.deepEqual(
    selectReviewStrategy({ requested: 'specialists', diff: low, analyzerCoverage: 'complete' }).reasons,
    ['forced-specialists'],
  );
  assert.equal(
    selectReviewStrategy({ requested: 'auto', diff: oneFile('src/value.ts', 80), analyzerCoverage: 'complete' })
      .selected,
    'single-pass',
  );
  assert.deepEqual(
    selectReviewStrategy({ requested: 'auto', diff: oneFile('src/value.ts', 81), analyzerCoverage: 'partial' }).reasons,
    ['many-changed-lines', 'partial-analyzer-coverage'],
  );
  assert.deepEqual(
    selectReviewStrategy({
      requested: 'auto',
      diff: oneFile('.github/workflows/review.yml'),
      analyzerCoverage: 'complete',
    }).reasons,
    ['sensitive-surface'],
  );
  assert.deepEqual(
    selectReviewStrategy({ requested: 'auto', diff: oneFile('src/auth/guard.ts'), analyzerCoverage: 'complete' })
      .reasons,
    ['sensitive-surface'],
  );
  assert.deepEqual(
    selectReviewStrategy({ requested: 'auto', diff: oneFile('src/auth.ts'), analyzerCoverage: 'complete' }).reasons,
    ['sensitive-surface'],
  );
  const threeFiles = prepareReviewedDiff(
    [0, 1, 2]
      .map(
        (index) =>
          `diff --git a/src/${index}.ts b/src/${index}.ts\n--- a/src/${index}.ts\n+++ b/src/${index}.ts\n@@ -0,0 +1 @@\n+export const v${index} = ${index};`,
      )
      .join('\n'),
    100_000,
  );
  assert.deepEqual(
    selectReviewStrategy({ requested: 'auto', diff: threeFiles, analyzerCoverage: 'complete' }).reasons,
    ['many-files'],
  );
});

test('auto routes bounded sensitive path and filename classes without substring false positives', () => {
  const sensitive = [
    '.github/workflows/review.yml',
    'action.yml',
    'src/actions/publish.ts',
    'src/workflow-runner.ts',
    'src/auth/session.ts',
    'src/credentials/store.ts',
    'src/client-secret.ts',
    'db/migrations/001.sql',
    'src/user-schema.ts',
    'src/api/public.ts',
    'src/http-routes.ts',
    'src/config.ts',
    'vite.config.ts',
    'package.json',
    'pnpm-lock.yaml',
    'Dockerfile',
    'containers/Dockerfile.production',
    `containers/Dockerfile.${'a'.repeat(32)}`,
    'Containerfile',
    'containers/Containerfile.dev',
    'compose.yaml',
    'deploy/compose.yml',
    'docker-compose.yaml',
    'deploy/docker-compose.yml',
  ];
  for (const path of sensitive) {
    assert.deepEqual(
      selectReviewStrategy({ requested: 'auto', diff: oneFile(path), analyzerCoverage: 'complete' }).reasons,
      ['sensitive-surface'],
      path,
    );
  }

  const nearMisses = [
    '.githubish/workflows-old/readme.md',
    'src/actionable.ts',
    'src/author.ts',
    'src/credentialing.ts',
    'src/secretary.ts',
    'db/migrate.ts',
    'src/schematic.ts',
    'src/rapid.ts',
    'src/router.ts',
    'src/configure.ts',
    'package.json.bak',
    'pnpm-lock.yaml.old',
    'Dockerfileish',
    'containerfiles',
    'Containerfileish',
    'Dockerfile.bak',
    'Dockerfile.production.bak',
    `Dockerfile.${'a'.repeat(33)}`,
    'Containerfile.old',
    'Containerfile.dev.copy',
    'compose.txt',
    'compose.yaml.bak',
    'docker-compose.yml.old',
  ];
  for (const path of nearMisses) {
    assert.deepEqual(
      selectReviewStrategy({ requested: 'auto', diff: oneFile(path), analyzerCoverage: 'complete' }).reasons,
      ['low-risk'],
      path,
    );
  }
});

test('role projections include only the fixed minimum context and remain byte bounded', () => {
  const source = (
    sourceId: string,
    sourceType: 'base-guidance' | 'base-configuration' | 'github-issue' | 'code-index' | 'deterministic-analysis',
    queryKind?: 'definition-and-types' | 'callers-and-tests' | 'callees' | 'configuration',
  ) => ({
    source: {
      source: sourceType,
      sourceId,
      status: 'included' as const,
      acquiredBytes: 2_000,
      includedBytes: 2_000,
      ...(queryKind ? { queryKind } : {}),
    },
    content: `${sourceId}:${'x'.repeat(1_900)}`,
  });
  const bundle = packReviewContext(
    [
      source('guidance', 'base-guidance'),
      source('config', 'base-configuration'),
      source('issue', 'github-issue'),
      source('types', 'code-index', 'definition-and-types'),
      source('tests', 'code-index', 'callers-and-tests'),
      source('callees', 'code-index', 'callees'),
      source('query-config', 'code-index', 'configuration'),
      source('analyzer', 'deterministic-analysis'),
    ],
    runtime,
  );
  const testing = serializeReviewContext(projectReviewContextForRole(bundle, 'testing'));
  assert.match(testing, /guidance/u);
  assert.match(testing, /tests/u);
  assert.doesNotMatch(testing, /types:/u);
  assert.doesNotMatch(testing, /callees:/u);
  assert.doesNotMatch(testing, /analyzer:/u);
  for (const role of SPECIALIST_ROLES) {
    assert.ok(
      Buffer.byteLength(serializeReviewContext(projectReviewContextForRole(bundle, role)), 'utf8') <=
        MAX_SPECIALIST_CONTEXT_BYTES,
    );
  }
  const arbiter = serializeReviewContext(projectArbiterContext(bundle));
  assert.match(arbiter, /guidance/u);
  assert.match(arbiter, /issue/u);
  assert.doesNotMatch(arbiter, /types:/u);
  assert.ok(Buffer.byteLength(arbiter, 'utf8') <= MAX_ARBITER_CONTEXT_BYTES);
});

test('prior findings route by fixed category and reservations account for every pass', () => {
  const base: ReviewStateFinding = {
    fingerprint: `sha256:${'A'.repeat(43)}`,
    anchorFingerprint: `sha256:${'B'.repeat(43)}`,
    evidenceDigest: `sha256:${'C'.repeat(43)}`,
    state: 'new',
    category: 'regression',
    severity: 'medium',
    confidenceBasisPoints: 9000,
    path: 'src/value.ts',
    side: 'RIGHT',
    line: 1,
    firstSeenHeadSha: 'a'.repeat(40),
    lastSeenHeadSha: 'b'.repeat(40),
    supersededBy: null,
  };
  assert.deepEqual(priorFindingsForRole([base], 'compatibility'), [base]);
  assert.deepEqual(priorFindingsForRole([base], 'correctness'), []);
  const prompts = ['a', 'bb', 'ccc', 'dddd'];
  const reserved = reserveSpecialistTokens({ prompts, maximumOutputTokens: 10_000 });
  const reasoningReserved = reserveSpecialistTokens({
    prompts,
    maximumOutputTokens: 943_718,
    reasoning: true,
  });
  assert.ok(reserved > 100_000);
  assert.ok(reasoningReserved > reserved);
  assert.ok(reasoningReserved < 2_000_000);
  assert.equal(specialistOutputTokens(943_718), 4_096);
  assert.equal(arbiterOutputTokens(943_718), 2_048);
  assert.equal(specialistOutputTokens(943_718, true), 65_536);
  assert.equal(arbiterOutputTokens(943_718, true), 32_768);
  assert.throws(() => reserveSpecialistTokens({ prompts: ['only one'], maximumOutputTokens: 10 }), /Every fixed/);
});
