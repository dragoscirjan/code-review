import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assessReview } from '../src/finding-validation';
import {
  MAX_REVIEW_STATE_ENCODED_BYTES,
  parseReviewState,
  publicationDigest,
  reviewInputDigest,
  REVIEW_SEMANTIC_VERSIONS,
  reconcileFindingStates,
  reviewPolicyDigest,
  serializeReviewState,
  stateScopeMatches,
  type ReviewStateFinding,
  type ReviewStateV1,
} from '../src/review-lifecycle';
import { prepareReviewedDiff } from '../src/unified-diff';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const nextSha = 'c'.repeat(40);
const marker = '<!-- code-review:opencode:v5 -->';

function findingState(overrides: Partial<ReviewStateFinding> = {}): ReviewStateFinding {
  return {
    fingerprint: `sha256:${'A'.repeat(43)}`,
    anchorFingerprint: `sha256:${'B'.repeat(43)}`,
    evidenceDigest: `sha256:${'C'.repeat(43)}`,
    state: 'new',
    category: 'security',
    severity: 'high',
    confidenceBasisPoints: 9000,
    path: 'src/file.ts',
    side: 'RIGHT',
    line: 2,
    firstSeenHeadSha: headSha,
    lastSeenHeadSha: headSha,
    supersededBy: null,
    ...overrides,
  };
}

function state(overrides: Partial<ReviewStateV1> = {}): ReviewStateV1 {
  const value: ReviewStateV1 = {
    version: 1,
    apiUrl: 'https://api.github.com',
    repository: 'owner/repository',
    pullRequest: 22,
    backend: 'opencode',
    actorId: 7,
    baseSha,
    headSha,
    completedThroughHeadSha: headSha,
    generation: 1,
    policyDigest: `sha256:${'D'.repeat(43)}`,
    reviewInputDigest: `sha256:${'I'.repeat(43)}`,
    publicationDigest: `sha256:${'E'.repeat(43)}`,
    inlineHistorySuppressed: 0,
    inlineLimitOmitted: 0,
    coverageComplete: true,
    mode: 'full',
    fromHeadSha: null,
    findings: [findingState()],
    ...overrides,
  };
  value.publicationDigest =
    overrides.publicationDigest ??
    publicationDigest({
      repository: value.repository,
      pullRequest: value.pullRequest,
      backend: value.backend,
      actorId: value.actorId,
      headSha: value.headSha,
      fingerprints: value.findings
        .filter((finding) => finding.state === 'new' || finding.state === 'unchanged')
        .map((finding) => finding.fingerprint),
    });
  return value;
}

function assessed(
  diffText: string,
  line: number,
  explanation = 'Problem here.',
  confidence = 0.9,
  severity: 'critical' | 'high' | 'medium' | 'low' = 'high',
  evidence = 'unsafe();',
) {
  const diff = prepareReviewedDiff(diffText, 20_000);
  const assessment = assessReview(
    {
      version: 1,
      outcome: 'findings',
      findings: [
        {
          category: 'security',
          severity,
          confidence,
          location: { path: 'src/file.ts', side: 'RIGHT', line },
          evidence,
          explanation,
          fix: 'fix it',
        },
      ],
    },
    diff.parsed,
    { minimumConfidence: 0, maximumInlineComments: 1 },
  );
  return assessment.findings[0]!;
}

const firstDiff = [
  'diff --git a/src/file.ts b/src/file.ts',
  '--- a/src/file.ts',
  '+++ b/src/file.ts',
  '@@ -1,2 +1,3 @@',
  ' start();',
  '+unsafe();',
  ' end();',
].join('\n');
const shiftedDiff = [
  'diff --git a/src/file.ts b/src/file.ts',
  '--- a/src/file.ts',
  '+++ b/src/file.ts',
  '@@ -1,2 +1,4 @@',
  ' start();',
  '+prefix();',
  '+unsafe();',
  ' end();',
].join('\n');

test('serializes canonical bounded state immediately before the final marker', () => {
  const line = serializeReviewState(state());
  assert.doesNotMatch(line, /-->(?:.|\n)+<!--/u);
  const parsed = parseReviewState(`summary\n${line}\n${marker}`, marker);
  assert.equal(parsed.kind, 'valid');
  if (parsed.kind === 'valid') assert.deepEqual(parsed.state, state());
});

test('ignores unsupported and rejects malformed, duplicate, displaced, and oversized metadata', () => {
  assert.equal(parseReviewState(`summary\n<!-- code-review-state:v2:AAAA -->\n${marker}`, marker).kind, 'unsupported');
  assert.equal(
    parseReviewState(`summary\n<!-- code-review-state:v1:not*base64 -->\n${marker}`, marker).kind,
    'malformed',
  );
  const valid = serializeReviewState(state());
  assert.equal(parseReviewState(`${valid}\ntext\n${marker}`, marker).kind, 'malformed');
  assert.equal(parseReviewState(`${valid}\n${valid}\n${marker}`, marker).kind, 'malformed');
  assert.equal(
    parseReviewState(
      `<!-- code-review-state:v1:${'A'.repeat(MAX_REVIEW_STATE_ENCODED_BYTES + 1)} -->\n${marker}`,
      marker,
    ).kind,
    'malformed',
  );
  assert.equal(parseReviewState(`legacy\n<!-- code-review:opencode:v4 -->`, marker).kind, 'legacy');
});

test('rejects noncanonical JSON, duplicate fingerprints, unknown fields, and invalid relationships', () => {
  const cases: unknown[] = [
    Object.fromEntries(Object.entries(state()).filter(([key]) => key !== 'reviewInputDigest')),
    { ...state(), extra: true },
    { ...state(), findings: [findingState(), findingState()] },
    { ...state(), findings: [findingState({ state: 'resolved', supersededBy: `sha256:${'Z'.repeat(43)}` })] },
  ];
  for (const value of cases) {
    const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    assert.equal(parseReviewState(`<!-- code-review-state:v1:${encoded} -->\n${marker}`, marker).kind, 'malformed');
  }
  const noncanonical = Buffer.from(`{ "version": 1 }`, 'utf8').toString('base64url');
  assert.equal(parseReviewState(`<!-- code-review-state:v1:${noncanonical} -->\n${marker}`, marker).kind, 'malformed');
});

test('fingerprints survive line shifts and ranking/fix changes but distinguish explanation and byte identity', () => {
  const first = assessed(firstDiff, 2);
  const shifted = assessed(shiftedDiff, 3, '  Problem\n\there.  ', 0.2, 'low');
  assert.equal(first.anchorFingerprint, shifted.anchorFingerprint);
  assert.equal(first.fingerprint, shifted.fingerprint);
  const changedExplanation = assessed(shiftedDiff, 3, 'Different problem.');
  assert.equal(first.anchorFingerprint, changedExplanation.anchorFingerprint);
  assert.notEqual(first.fingerprint, changedExplanation.fingerprint);
  const different = assessed(firstDiff.replace('unsafe();', 'unsafÉ();'), 2, 'Problem here.', 0.9, 'high', 'unsafÉ();');
  assert.notEqual(first.anchorFingerprint, different.anchorFingerprint);
});

test('keeps anchors stable when an unrelated identical changed line is inserted in an earlier hunk', () => {
  const initial = [
    'diff --git a/src/file.ts b/src/file.ts',
    '--- a/src/file.ts',
    '+++ b/src/file.ts',
    '@@ -10,2 +10,3 @@',
    ' targetBefore();',
    '+unsafe();',
    ' targetAfter();',
  ].join('\n');
  const withEarlierIdenticalLine = [
    'diff --git a/src/file.ts b/src/file.ts',
    '--- a/src/file.ts',
    '+++ b/src/file.ts',
    '@@ -1,2 +1,3 @@',
    ' unrelatedBefore();',
    '+unsafe();',
    ' unrelatedAfter();',
    '@@ -10,2 +11,3 @@',
    ' targetBefore();',
    '+unsafe();',
    ' targetAfter();',
  ].join('\n');
  const before = assessed(initial, 11);
  const after = assessed(withEarlierIdenticalLine, 12);
  assert.equal(after.anchorFingerprint, before.anchorFingerprint);
  assert.equal(after.fingerprint, before.fingerprint);
});

test('classifies unchanged, new, resolved, and superseded findings deterministically', () => {
  const exact = assessed(firstDiff, 2);
  const priorExact = findingState({
    fingerprint: exact.fingerprint,
    anchorFingerprint: exact.anchorFingerprint,
    evidenceDigest: exact.evidenceDigest,
  });
  const unchanged = reconcileFindingStates([exact], [priorExact], nextSha);
  assert.deepEqual(unchanged.counts, { new: 0, unchanged: 1, resolved: 0, superseded: 0 });

  const changed = assessed(firstDiff, 2, 'Changed explanation');
  const superseded = reconcileFindingStates([changed], [priorExact], nextSha);
  assert.deepEqual(superseded.counts, { new: 1, unchanged: 0, resolved: 0, superseded: 1 });
  assert.equal(superseded.tombstones[0]?.supersededBy, changed.fingerprint);

  const resolved = reconcileFindingStates([], [priorExact], nextSha);
  assert.deepEqual(resolved.counts, { new: 0, unchanged: 0, resolved: 1, superseded: 0 });
});

test('same-head reuse rejects title, body, linked-issue, context, and fixed-policy changes', () => {
  const baseline = {
    policyDigest: `sha256:${'P'.repeat(43)}`,
    pullRequest: { title: 'Title', body: 'Body', author: 'author' },
    contextDigest: `sha256:${'C'.repeat(43)}`,
    analyzerResultDigest: `sha256:${'A'.repeat(43)}`,
    executionPlanDigest: `sha256:${'E'.repeat(43)}`,
    linkedIssues: [{ number: 22, digest: 'a'.repeat(64) }],
  };
  const original = reviewInputDigest(baseline);
  const changedInputDigests = [
    reviewInputDigest({ ...baseline, pullRequest: { ...baseline.pullRequest, title: 'Changed' } }),
    reviewInputDigest({ ...baseline, pullRequest: { ...baseline.pullRequest, body: 'Changed' } }),
    reviewInputDigest({ ...baseline, pullRequest: { ...baseline.pullRequest, author: 'changed-author' } }),
    reviewInputDigest({ ...baseline, contextDigest: `sha256:${'D'.repeat(43)}` }),
    reviewInputDigest({ ...baseline, analyzerResultDigest: `sha256:${'B'.repeat(43)}` }),
    reviewInputDigest({ ...baseline, executionPlanDigest: `sha256:${'F'.repeat(43)}` }),
    reviewInputDigest({ ...baseline, linkedIssues: [{ number: 22, digest: 'b'.repeat(64) }] }),
    reviewInputDigest(baseline, {
      ...REVIEW_SEMANTIC_VERSIONS,
      reviewPolicy: REVIEW_SEMANTIC_VERSIONS.reviewPolicy + 1,
    }),
  ];
  const value = state({ reviewInputDigest: original });
  for (const changedInputDigest of changedInputDigests) {
    assert.notEqual(changedInputDigest, original);
    assert.equal(
      stateScopeMatches(value, {
        apiUrl: value.apiUrl,
        repository: value.repository,
        pullRequest: value.pullRequest,
        backend: value.backend,
        actorId: value.actorId,
        baseSha: value.baseSha,
        policyDigest: value.policyDigest,
        reviewInputDigest: changedInputDigest,
      }),
      false,
    );
  }
});

test('policy and scope bind state without credential material', () => {
  const policyInput = {
    backend: 'opencode',
    model: 'model',
    modelApi: 'openai-completions',
    modelBaseUrl: 'https://example.test/v1',
    modelNetwork: 'remote',
    contextWindow: 128_000,
    maximumOutputTokens: 8_192,
    containerEngine: 'podman',
    customPrompt: 'prompt',
    minimumConfidence: 0.5,
    maximumInlineComments: 3,
    maximumDiffBytes: 120_000,
    indexer: 'gitnexus',
    opencodeVersion: '1.0.0',
    piVersion: '1.0.0',
    deterministicAnalyzerManifestDigest: `sha256:${'M'.repeat(43)}`,
    requestedReviewStrategy: 'auto',
    specialistTokenBudget: 300_000,
    aggregateTimeoutMs: 600_000,
    specialistPolicy: {
      roleSetVersion: 1,
      selectorVersion: 1,
      arbiterContractVersion: 1,
      contextProjectionVersion: 1,
      maximumRolePasses: 4,
      maximumArbiterPasses: 1,
      maximumFindingsPerRole: 3,
      maximumRawFindings: 12,
      maximumArbiterCandidates: 10,
      maximumSpecialistContextBytes: 20_000,
      maximumArbiterContextBytes: 12_000,
      maximumArbiterPromptBytes: 100_000,
      specialistRequestOverheadTokens: 1_024,
      specialistOutputTokens: 4_096,
      arbiterOutputTokens: 2_048,
    },
  } as const;
  const policy = reviewPolicyDigest(policyInput);
  assert.notEqual(
    policy,
    reviewPolicyDigest({ ...policyInput, deterministicAnalyzerManifestDigest: `sha256:${'N'.repeat(43)}` }),
  );
  assert.notEqual(policy, reviewPolicyDigest({ ...policyInput, requestedReviewStrategy: 'single-pass' }));
  assert.notEqual(policy, reviewPolicyDigest({ ...policyInput, specialistTokenBudget: 400_000 }));
  assert.notEqual(
    policy,
    reviewPolicyDigest({
      ...policyInput,
      specialistPolicy: { ...policyInput.specialistPolicy, arbiterContractVersion: 2 },
    }),
  );
  assert.match(policy, /^sha256:[A-Za-z0-9_-]{43}$/u);
  const value = state({ policyDigest: policy });
  assert.equal(
    stateScopeMatches(value, {
      apiUrl: value.apiUrl,
      repository: value.repository,
      pullRequest: value.pullRequest,
      backend: value.backend,
      actorId: value.actorId,
      baseSha: value.baseSha,
      policyDigest: policy,
      reviewInputDigest: value.reviewInputDigest,
    }),
    true,
  );
  assert.equal(
    stateScopeMatches(value, {
      apiUrl: value.apiUrl,
      repository: value.repository,
      pullRequest: value.pullRequest + 1,
      backend: value.backend,
      actorId: value.actorId,
      baseSha: value.baseSha,
      policyDigest: policy,
      reviewInputDigest: value.reviewInputDigest,
    }),
    false,
  );
});
