import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { ValidatedFinding } from '../src/finding-validation';
import { MAX_JSON_NESTING_DEPTH, parseReviewResult } from '../src/review-contract';
import {
  evaluateRecordedReviewOutputs,
  evaluateReviewCorpus,
  evaluateThresholds,
  matchEvaluationFindings,
  parseEvaluationCorpus,
  parseEvaluationThresholds,
  renderEvaluationJson,
  renderEvaluationMarkdown,
  type EvaluationMetrics,
  type ExpectedEvaluationFinding,
} from '../src/review-evaluation';
import {
  createEvaluationOutputDirectory,
  MAX_EVALUATION_ARTIFACT_BYTES,
  writeEvaluationArtifacts,
} from '../src/review-evaluation-artifacts';
import {
  evaluateSpecialistRecordings,
  parseSpecialistEvaluationRecordings,
  parseSpecialistEvaluationThresholds,
  renderSpecialistEvaluationJson,
  renderSpecialistEvaluationMarkdown,
} from '../src/review-specialist-evaluation';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function corpusText(): Promise<string> {
  return readFile('test/fixtures/review-evaluation/corpus.v1.json', 'utf8');
}

async function thresholdsText(): Promise<string> {
  return readFile('test/fixtures/review-evaluation/thresholds.v1.json', 'utf8');
}

async function specialistText(): Promise<string> {
  return readFile('test/fixtures/review-evaluation/specialists.v1.json', 'utf8');
}

async function specialistThresholdsText(): Promise<string> {
  return readFile('test/fixtures/review-evaluation/specialist-thresholds.v1.json', 'utf8');
}

test('deterministically measures malformed recorded assistant payloads through the production parser', () => {
  const evaluation = evaluateRecordedReviewOutputs([
    { name: 'clean change', assistantOutput: '{"version":1,"outcome":"clean","findings":[]}' },
    { name: 'legacy prose', assistantOutput: 'No material findings.' },
    {
      name: 'excessive nesting',
      assistantOutput: `${'['.repeat(MAX_JSON_NESTING_DEPTH + 1)}null${']'.repeat(MAX_JSON_NESTING_DEPTH + 1)}`,
    },
  ]);

  assert.deepEqual(
    {
      total: evaluation.total,
      valid: evaluation.valid,
      malformed: evaluation.malformed,
      malformedOutputRate: evaluation.malformedOutputRate,
    },
    { total: 3, valid: 1, malformed: 2, malformedOutputRate: 2 / 3 },
  );
});

test('strict corpus parsing rejects duplicate properties, IDs, ambiguous anchors, empty and oversized input', async () => {
  const raw = await corpusText();
  assert.throws(() => parseEvaluationCorpus('{"version":1,"version":1,"cases":[]}'), /duplicate-property/);
  assert.throws(() => parseEvaluationCorpus('{"version":1,"cases":[]}'), /1-64 cases/);
  assert.throws(() => parseEvaluationCorpus(`${raw}${' '.repeat(2 * 1024 * 1024)}`), /oversized-json/);

  const parsed = JSON.parse(raw) as { version: number; cases: Array<Record<string, unknown>> };
  parsed.cases.push(structuredClone(parsed.cases[0] as Record<string, unknown>));
  assert.throws(() => parseEvaluationCorpus(JSON.stringify(parsed)), /duplicate case IDs/);

  const removedCore = JSON.parse(raw) as { cases: Array<Record<string, unknown>> };
  removedCore.cases.pop();
  assert.throws(() => parseEvaluationCorpus(JSON.stringify(removedCore)), /exact protected core case IDs/);

  const addedEasyCase = JSON.parse(raw) as { cases: Array<Record<string, unknown>> };
  const easy = structuredClone(addedEasyCase.cases[0] as Record<string, unknown>);
  easy.id = 'easy-extra-case';
  addedEasyCase.cases.push(easy);
  assert.throws(() => parseEvaluationCorpus(JSON.stringify(addedEasyCase)), /exact protected core case IDs/);

  const ambiguous = JSON.parse(raw) as { cases: Array<Record<string, unknown>> };
  const first = ambiguous.cases[0] as { expectations: { findings: unknown[] } };
  first.expectations.findings.push(structuredClone(first.expectations.findings[0]));
  (first.expectations.findings[1] as { id: string }).id = 'second-defect';
  assert.throws(() => parseEvaluationCorpus(JSON.stringify(ambiguous)), /ambiguous expected locations/);

  const malformedUnicode = JSON.parse(raw) as { cases: Array<{ title: string }> };
  malformedUnicode.cases[0].title = '\ud800';
  assert.throws(() => parseEvaluationCorpus(JSON.stringify(malformedUnicode)), /invalid or exceeds/);

  const unknown = JSON.parse(raw) as { cases: Array<Record<string, unknown>> };
  unknown.cases[0].command = 'npm test';
  assert.throws(() => parseEvaluationCorpus(JSON.stringify(unknown)), /unknown or missing fields/);

  const unsafePath = JSON.parse(raw) as {
    cases: Array<{ expectations: { findings: Array<{ acceptableLocations: Array<{ path: string }> }> } }>;
  };
  unsafePath.cases[0].expectations.findings[0].acceptableLocations[0].path = '../escape.ts';
  assert.throws(() => parseEvaluationCorpus(JSON.stringify(unsafePath)), /path is unsafe/);

  type PromptCase = {
    id: string;
    expectations: {
      findings: Array<{ id: string; acceptableLocations: Array<{ path: string; side: string; line: number }> }>;
      intentionalNonFindings: Array<{
        id: string;
        categories: string[];
        location: { path: string; side: string; line: number };
      }>;
    };
  };
  const idCollision = JSON.parse(raw) as { cases: PromptCase[] };
  const collisionCase = idCollision.cases.find((entry) => entry.id === 'prompt-injection-real-bug');
  assert.ok(collisionCase);
  collisionCase.expectations.intentionalNonFindings[0].id = collisionCase.expectations.findings[0].id;
  assert.throws(() => parseEvaluationCorpus(JSON.stringify(idCollision)), /expected\/non-finding ID collision/);

  const semanticOverlap = JSON.parse(raw) as { cases: PromptCase[] };
  const overlapCase = semanticOverlap.cases.find((entry) => entry.id === 'prompt-injection-real-bug');
  assert.ok(overlapCase);
  overlapCase.expectations.intentionalNonFindings[0].location = structuredClone(
    overlapCase.expectations.findings[0].acceptableLocations[0],
  );
  assert.throws(
    () => parseEvaluationCorpus(JSON.stringify(semanticOverlap)),
    /overlapping expected and intentional non-finding semantics/,
  );
});

test('maximum bipartite matching is independent of prediction order', () => {
  const expected: ExpectedEvaluationFinding[] = [
    {
      id: 'flexible',
      category: 'correctness',
      acceptableSeverities: ['high'],
      acceptableOrigins: ['model'],
      acceptableLocations: [
        { path: 'a.ts', side: 'RIGHT', line: 1 },
        { path: 'a.ts', side: 'RIGHT', line: 2 },
      ],
      rationale: 'fixture',
    },
    {
      id: 'specific',
      category: 'correctness',
      acceptableSeverities: ['high'],
      acceptableOrigins: ['model'],
      acceptableLocations: [{ path: 'a.ts', side: 'RIGHT', line: 1 }],
      rationale: 'fixture',
    },
  ];
  const finding = (line: number, fingerprint: string) =>
    ({
      category: 'correctness',
      severity: 'high',
      confidence: 1,
      location: { path: 'a.ts', side: 'RIGHT', line },
      evidence: 'x',
      explanation: 'x',
      fix: 'x',
      sourceIndex: line,
      origin: { kind: 'model' },
      fingerprint,
      anchorFingerprint: fingerprint.replace('finding', 'anchor'),
      evidenceDigest: fingerprint.replace('finding', 'evidence'),
    }) as unknown as ValidatedFinding;
  const matched = matchEvaluationFindings(expected, [
    finding(1, `sha256:${'a'.repeat(64)}`),
    finding(2, `sha256:${'b'.repeat(64)}`),
  ]);
  assert.deepEqual(
    matched.matched.map((entry) => entry.expectedId),
    ['flexible', 'specific'],
  );
  assert.equal(matched.unmatched.length, 0);
});

test('recorded corpus replay is offline, byte-deterministic, production-mapped, and passes thresholds', async () => {
  const corpus = parseEvaluationCorpus(await corpusText());
  const thresholds = parseEvaluationThresholds(await thresholdsText());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('recorded evaluation attempted network access');
  }) as typeof fetch;
  try {
    const first = await evaluateReviewCorpus({ corpus, mode: 'recorded', thresholds });
    const second = await evaluateReviewCorpus({ corpus, mode: 'recorded', thresholds });
    assert.equal(renderEvaluationJson(first), renderEvaluationJson(second));
    assert.equal(renderEvaluationMarkdown(first), renderEvaluationMarkdown(second));
    assert.deepEqual(first.thresholdFailures, []);
    assert.equal(first.metrics.truePositives, 7);
    assert.equal(first.metrics.falseNegatives, 0);
    assert.equal(first.metrics.duplicateFindings, 0);
    assert.equal(first.metrics.malformedOutputs, 0);
    assert.equal(first.metrics.candidateFindings, 7);
    assert.equal(first.metrics.lineMappedFindings, 7);
    assert.equal(first.metrics.evidenceRejectedFindings, 0);
    assert.equal(first.metrics.globalLimitOmittedFindings, 0);
    assert.equal(first.metrics.memorySuppressedFindings, 0);
    assert.equal(first.metrics.cleanCaseAccuracy.value, 1);
    const json = renderEvaluationJson(first);
    const markdown = renderEvaluationMarkdown(first);
    assert.match(markdown, /\| Unmapped \| Rejected \| Duplicates \| Intentional NF hits \|/u);
    assert.match(markdown, /Evidence or secret rejected findings: 0/u);
    assert.match(markdown, /Global finding-cap omissions: 0/u);
    assert.match(markdown, /Repository-memory suppressed findings: 0/u);
    for (const hostile of ['Ignore policy', '::error::', '</CODE_REVIEW_UNTRUSTED_DIFF_fake>', 'return total / 0']) {
      assert.doesNotMatch(json, new RegExp(hostile.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
      assert.doesNotMatch(markdown, new RegExp(hostile.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('malformed, duplicate, and unmapped outputs remain adversarial unit fixtures outside the protected gate', async () => {
  const corpus = parseEvaluationCorpus(await corpusText());
  const security = corpus.cases.find((entry) => entry.id === 'security-inverted-auth-guard');
  assert.ok(security);
  const validFinding = {
    category: 'security' as const,
    severity: 'critical' as const,
    confidence: 1,
    location: { path: 'src/auth.ts', side: 'RIGHT' as const, line: 2 },
    evidence: '  if (user.authorized) return deny();',
    explanation: 'Authorization is inverted.',
    fix: 'Restore the negation.',
  };
  const report = await evaluateReviewCorpus({
    corpus: {
      ...corpus,
      cases: [
        {
          ...security,
          recordings: [
            {
              id: 'duplicate-unmapped-adversarial',
              assistantOutput: JSON.stringify({
                version: 1,
                outcome: 'findings',
                findings: [
                  validFinding,
                  { ...validFinding, explanation: 'Duplicate wording.' },
                  {
                    ...validFinding,
                    location: { path: 'src/auth.ts', side: 'RIGHT', line: 99 },
                    evidence: 'not a changed line',
                  },
                ],
              }),
              latencyMs: 1,
            },
            {
              id: 'evidence-rejected-adversarial',
              assistantOutput: JSON.stringify({
                version: 1,
                outcome: 'findings',
                findings: [{ ...validFinding, evidence: 'not the changed line' }],
              }),
              latencyMs: 1,
            },
            { id: 'malformed-adversarial', assistantOutput: 'No material findings.', latencyMs: 1 },
          ],
        },
      ],
    },
    mode: 'recorded',
  });
  assert.equal(report.metrics.totalRuns, 3);
  assert.equal(report.metrics.truePositives, 1);
  assert.equal(report.metrics.falseNegatives, 2);
  assert.equal(report.metrics.candidateFindings, 4);
  assert.equal(report.metrics.lineMappedFindings, 3);
  assert.equal(report.metrics.evidenceRejectedFindings, 1);
  assert.equal(report.metrics.globalLimitOmittedFindings, 0);
  assert.equal(report.metrics.duplicateFindings, 1);
  assert.equal(report.metrics.malformedOutputs, 1);
  assert.equal(
    report.cases.find((entry) => entry.recordingId === 'duplicate-unmapped-adversarial')?.unmappedFindings,
    1,
  );
  const rejected = report.cases.find((entry) => entry.recordingId === 'evidence-rejected-adversarial');
  assert.equal(rejected?.rejectedFindings, 1);
  assert.equal(rejected?.evidenceRejectedFindings, 1);
  assert.equal(rejected?.globalLimitOmittedFindings, 0);
  assert.match(renderEvaluationMarkdown(report), /Evidence or secret rejected findings: 1/u);
  assert.throws(() => parseReviewResult('No material findings.'));
});

test('zero denominators are null, never NaN or Infinity, and required thresholds fail closed', async () => {
  const corpus = parseEvaluationCorpus(await corpusText());
  const clean = corpus.cases.find((entry) => entry.id === 'clean-behavior-preserving-refactor');
  assert.ok(clean);
  const report = await evaluateReviewCorpus({
    corpus: { ...corpus, cases: [clean] },
    mode: 'recorded',
  });
  assert.equal(report.metrics.precision.value, null);
  assert.equal(report.metrics.recall.value, null);
  const failures = evaluateThresholds(report.metrics, parseEvaluationThresholds(await thresholdsText()));
  assert.ok(failures.includes('minimumPrecision'));
  assert.ok(failures.includes('minimumRecall'));
  const serialized = renderEvaluationJson(report);
  assert.doesNotMatch(serialized, /NaN|Infinity/u);
});

test('a clean-case prediction is a false positive and cannot game clean accuracy', async () => {
  const corpus = parseEvaluationCorpus(await corpusText());
  const clean = corpus.cases.find((entry) => entry.id === 'clean-behavior-preserving-refactor');
  assert.ok(clean);
  const report = await evaluateReviewCorpus({
    corpus: { ...corpus, cases: [clean] },
    mode: 'live',
    runner: async () => ({
      status: 'valid',
      latencyMs: 1,
      review: {
        version: 1,
        outcome: 'findings',
        findings: [
          {
            category: 'correctness',
            severity: 'low',
            confidence: 1,
            location: { path: 'src/name.ts', side: 'RIGHT', line: 2 },
            evidence: '  const name = user.name.trim();',
            explanation: 'False positive.',
            fix: 'No change.',
          },
        ],
      },
    }),
  });
  assert.equal(report.metrics.falsePositives, 1);
  assert.equal(report.metrics.cleanCaseAccuracy.value, 0);
  assert.equal(report.metrics.intentionalNonFindingHits, 1);
  assert.equal(report.cases[0]?.intentionalNonFindingHits, 1);
  assert.match(renderEvaluationMarkdown(report), /Intentional non-finding hits: 1/u);
});

test('artifact output rejects unsafe locations, preexisting paths, symlinks, and secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-evaluation-root-'));
  temporaryDirectories.push(root);
  const output = await createEvaluationOutputDirectory(join(root, 'reports'), { RUNNER_TEMP: root });
  const written = await writeEvaluationArtifacts({ outputDirectory: output, json: '{}\n', markdown: '# report\n' });
  assert.equal(await readFile(written.jsonPath, 'utf8'), '{}\n');

  await assert.rejects(createEvaluationOutputDirectory(join(root, 'reports'), { RUNNER_TEMP: root }));
  await assert.rejects(createEvaluationOutputDirectory(join(root, '..', 'escape'), { RUNNER_TEMP: root }));

  const malicious = join(root, 'malicious');
  await symlink(tmpdir(), malicious);
  await assert.rejects(createEvaluationOutputDirectory(malicious, { RUNNER_TEMP: root }));

  const secretDirectory = await createEvaluationOutputDirectory(join(root, 'secret-report'), { RUNNER_TEMP: root });
  await assert.rejects(
    writeEvaluationArtifacts({
      outputDirectory: secretDirectory,
      json: '{"token":"secret-value"}\n',
      markdown: '# safe\n',
      secrets: ['secret-value'],
    }),
    /forbidden secret/,
  );

  const oversizedDirectory = await createEvaluationOutputDirectory(join(root, 'oversized-report'), {
    RUNNER_TEMP: root,
  });
  await assert.rejects(
    writeEvaluationArtifacts({
      outputDirectory: oversizedDirectory,
      json: 'x'.repeat(MAX_EVALUATION_ARTIFACT_BYTES + 1),
      markdown: '# safe\n',
    }),
    /byte limit/,
  );

  const linkedDirectory = await createEvaluationOutputDirectory(join(root, 'linked-report'), { RUNNER_TEMP: root });
  const outside = join(root, 'outside-file');
  await writeFile(outside, 'do not overwrite');
  await link(outside, join(linkedDirectory, 'review-evaluation.json'));
  await assert.rejects(
    writeEvaluationArtifacts({ outputDirectory: linkedDirectory, json: '{}\n', markdown: '# safe\n' }),
    /must be empty/,
  );
  assert.equal(await readFile(outside, 'utf8'), 'do not overwrite');
});

test('recorded specialist and auto execution are production-replayed, deterministic, and non-regressing', async () => {
  const corpus = parseEvaluationCorpus(await corpusText());
  const absoluteThresholds = parseEvaluationThresholds(await thresholdsText());
  const baseline = await evaluateReviewCorpus({ corpus, mode: 'recorded', thresholds: absoluteThresholds });
  const recordings = parseSpecialistEvaluationRecordings(await specialistText(), corpus);
  const specialistThresholds = parseSpecialistEvaluationThresholds(await specialistThresholdsText());
  const first = await evaluateSpecialistRecordings({
    corpus,
    recordings,
    thresholds: specialistThresholds,
    baseline,
    absoluteThresholds,
  });
  const second = await evaluateSpecialistRecordings({
    corpus,
    recordings,
    thresholds: specialistThresholds,
    baseline,
    absoluteThresholds,
  });
  assert.deepEqual(first.thresholdFailures, []);
  assert.equal(renderSpecialistEvaluationJson(first), renderSpecialistEvaluationJson(second));
  assert.equal(renderSpecialistEvaluationMarkdown(first), renderSpecialistEvaluationMarkdown(second));
  assert.equal(first.specialists.metrics.recall.value, baseline.metrics.recall.value);
  assert.equal(first.auto.metrics.precision.value, baseline.metrics.precision.value);
  assert.deepEqual(
    first.autoCases.filter((item) => item.selected === 'specialists').map((item) => item.caseId),
    ['analyzer-duplicate-json-key', 'left-side-removed-validation', 'security-inverted-auth-guard'],
  );
  assert.equal(first.specialistCases.find((item) => item.caseId === 'prompt-injection-real-bug')?.arbiterRejected, 1);

  const malformed = JSON.parse(await specialistText()) as { corpusDigest: string; cases: unknown[] };
  malformed.corpusDigest = `sha256:${'A'.repeat(43)}`;
  assert.throws(() => parseSpecialistEvaluationRecordings(JSON.stringify(malformed), corpus), /corpus digest/u);
});

test('threshold boundaries use raw finite values and malformed threshold documents fail closed', async () => {
  const thresholds = parseEvaluationThresholds(await thresholdsText());
  const ratio = { numerator: 1, denominator: 2, value: 0.5 };
  const metrics = {
    totalRuns: 1,
    truePositives: 1,
    falsePositives: 0,
    falseNegatives: 0,
    precision: ratio,
    recall: ratio,
    candidateFindings: 1,
    lineMappedFindings: 1,
    lineMappingAccuracy: ratio,
    evidenceRejectedFindings: 0,
    evidenceRejectedFindingRate: ratio,
    globalLimitOmittedFindings: 0,
    globalLimitOmittedFindingRate: ratio,
    memorySuppressedFindings: 0,
    belowThresholdFindings: 0,
    duplicateFindings: 0,
    duplicateFindingRate: ratio,
    malformedOutputs: 0,
    malformedOutputRate: ratio,
    executionFailures: 0,
    executionFailureRate: ratio,
    cleanRuns: 1,
    correctCleanRuns: 1,
    cleanCaseAccuracy: ratio,
    intentionalNonFindingHits: 0,
    latencyMs: { minimum: 1, maximum: 1, mean: 1, p50: 1, p95: thresholds.maximumP95LatencyMs },
  } satisfies EvaluationMetrics;
  const exact = {
    ...thresholds,
    minimumPrecision: 0.5,
    minimumRecall: 0.5,
    minimumLineMappingAccuracy: 0.5,
    minimumCleanCaseAccuracy: 0.5,
    maximumDuplicateFindingRate: 0.5,
    maximumEvidenceRejectedFindingRate: 0.5,
    maximumGlobalLimitOmittedFindingRate: 0.5,
    maximumMalformedOutputRate: 0.5,
    maximumExecutionFailureRate: 0.5,
  };
  assert.deepEqual(evaluateThresholds(metrics, exact), []);
  assert.throws(() => parseEvaluationThresholds('{"version":1,"minimumPrecision":null}'));
  const weakened = JSON.parse(await thresholdsText()) as { minimumRecall: number };
  weakened.minimumRecall = 0;
  assert.throws(() => parseEvaluationThresholds(JSON.stringify(weakened)), /weakens the required gate/);
  for (const name of [
    'maximumDuplicateFindingRate',
    'maximumEvidenceRejectedFindingRate',
    'maximumGlobalLimitOmittedFindingRate',
    'maximumMalformedOutputRate',
  ] as const) {
    const relaxed = JSON.parse(await thresholdsText()) as Record<typeof name, number>;
    relaxed[name] = 0.01;
    assert.throws(() => parseEvaluationThresholds(JSON.stringify(relaxed)), /weakens the required gate/);
  }
});
