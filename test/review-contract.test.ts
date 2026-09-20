/* eslint-disable vitest/expect-expect -- Contract rejection cases use the shared Node assertion helper. */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  MAX_JSON_NESTING_DEPTH,
  MAX_RENDERED_MODEL_TEXT_BYTES,
  MAX_REVIEW_RESULT_BYTES,
  ReviewContractError,
  parseReviewResult,
  type ReviewFinding,
} from '../src/review-contract';

const finding: ReviewFinding = {
  category: 'correctness',
  severity: 'high',
  confidence: 0.9,
  location: { path: 'src/math.ts', side: 'RIGHT', line: 14 },
  evidence: 'The changed expression subtracts the operands.',
  explanation: 'Callers of add now receive the opposite result.',
  fix: 'Restore the addition expression.',
};

function findingResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, outcome: 'findings', findings: [{ ...finding, ...overrides }] });
}

function aggregateBudgetResult(explanationAmpersands: number): string {
  const findings = Array.from({ length: 10 }, (_, index) => ({
    ...finding,
    location: { path: 'x', side: 'RIGHT', line: 1 },
    evidence: '&'.repeat(1_000),
    explanation: index === 0 ? '&'.repeat(explanationAmpersands) : 'x',
    fix: index === 0 ? 'xx' : 'x',
  }));
  return JSON.stringify({ version: 1, outcome: 'findings', findings });
}

function assertContractError(raw: string, code: ReviewContractError['code']): void {
  assert.throws(
    () => parseReviewResult(raw),
    (error) => error instanceof ReviewContractError && error.code === code && !error.message.includes(raw),
  );
}

test('parses explicit clean and populated version 1 reviews', () => {
  assert.deepEqual(parseReviewResult('{"version":1,"outcome":"clean","findings":[]}'), {
    version: 1,
    outcome: 'clean',
    findings: [],
  });
  assert.deepEqual(parseReviewResult(findingResult()), {
    version: 1,
    outcome: 'findings',
    findings: [finding],
  });
});

test('accepts all category and severity values and confidence boundaries', () => {
  for (const category of ['correctness', 'security', 'regression', 'testing']) {
    assert.equal(parseReviewResult(findingResult({ category })).findings[0]?.category, category);
  }
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    assert.equal(parseReviewResult(findingResult({ severity })).findings[0]?.severity, severity);
  }
  assert.equal(parseReviewResult(findingResult({ confidence: 0 })).findings[0]?.confidence, 0);
  assert.equal(parseReviewResult(findingResult({ confidence: 1 })).findings[0]?.confidence, 1);
});

describe('rejects malformed or guessed JSON', () => {
  test.each([
    { name: 'malformed', raw: '{"version":1,}' },
    { name: 'prefix', raw: `result: ${findingResult()}` },
    { name: 'suffix', raw: `${findingResult()} trailing` },
    { name: 'fence', raw: `\`\`\`json\n${findingResult()}\n\`\`\`` },
    { name: 'multiple documents', raw: '{}{}' },
    { name: 'non-JSON confidence', raw: findingResult().replace('0.9', 'NaN') },
  ])('$name', ({ raw }) => assertContractError(raw, 'invalid-json'));

  test('duplicate properties at any depth', () => {
    assertContractError('{"version":1,"version":1,"outcome":"clean","findings":[]}', 'duplicate-property');
    assertContractError(findingResult().replace('"line":14', '"line":14,"line":15'), 'duplicate-property');
  });
});

test('rejects unsupported, missing, and unknown root fields', () => {
  assertContractError('{"version":2,"outcome":"clean","findings":[]}', 'invalid-version');
  assertContractError('{"outcome":"clean","findings":[]}', 'invalid-shape');
  assertContractError('{"version":1,"outcome":"clean","findings":[],"summary":"ok"}', 'invalid-shape');
});

test('rejects invalid category, severity, confidence, location, and outcome consistency', () => {
  assertContractError(findingResult({ category: 'style' }), 'invalid-field');
  assertContractError(findingResult({ severity: 'urgent' }), 'invalid-field');
  assertContractError(findingResult({ confidence: -0.01 }), 'invalid-field');
  assertContractError(findingResult({ confidence: 1.01 }), 'invalid-field');
  assertContractError(findingResult({ confidence: '0.9' }), 'invalid-field');
  assertContractError(findingResult({ location: { path: 'src/math.ts', side: 'CENTER', line: 14 } }), 'invalid-field');
  assertContractError(findingResult({ location: { path: 'src/math.ts', side: 'RIGHT', line: 0 } }), 'invalid-field');
  assertContractError(findingResult({ location: { path: 'src/math.ts', side: 'RIGHT', line: 1.5 } }), 'invalid-field');
  assertContractError(JSON.stringify({ version: 1, outcome: 'clean', findings: [finding] }), 'invalid-field');
  assertContractError(JSON.stringify({ version: 1, outcome: 'findings', findings: [] }), 'invalid-field');
});

test('rejects extra or missing finding and location fields', () => {
  assertContractError(findingResult({ title: 'Regression' }), 'invalid-shape');
  const withoutFix: Partial<ReviewFinding> = { ...finding };
  delete withoutFix.fix;
  assertContractError(JSON.stringify({ version: 1, outcome: 'findings', findings: [withoutFix] }), 'invalid-shape');
  assertContractError(
    findingResult({ location: { path: 'src/math.ts', side: 'RIGHT', line: 14, column: 1 } }),
    'invalid-shape',
  );
  assertContractError(findingResult({ location: null }), 'invalid-shape');
});

test('enforces UTF-8 field and finding-count limits', () => {
  assert.equal(
    parseReviewResult(
      findingResult({
        evidence: 'é'.repeat(500),
        explanation: 'x'.repeat(1_000),
        fix: 'x'.repeat(2_000),
        location: { path: 'x'.repeat(1_024), side: 'RIGHT', line: 1 },
      }),
    ).findings.length,
    1,
  );
  assert.equal(
    parseReviewResult(JSON.stringify({ version: 1, outcome: 'findings', findings: Array(10).fill(finding) })).findings
      .length,
    10,
  );
  assertContractError(findingResult({ evidence: `${'é'.repeat(500)}a` }), 'oversized-output');
  assertContractError(findingResult({ explanation: 'x'.repeat(1_001) }), 'oversized-output');
  assertContractError(findingResult({ fix: 'x'.repeat(2_001) }), 'oversized-output');
  assertContractError(
    findingResult({ location: { path: 'x'.repeat(1_025), side: 'RIGHT', line: 1 } }),
    'oversized-output',
  );
  assertContractError(
    JSON.stringify({ version: 1, outcome: 'findings', findings: Array(11).fill(finding) }),
    'oversized-output',
  );
});

test('rejects blank, control-containing, and malformed Unicode strings', () => {
  assertContractError(findingResult({ evidence: '   ' }), 'invalid-field');
  assertContractError(findingResult({ evidence: 'unsafe\u0001text' }), 'invalid-field');
  assertContractError(findingResult({ location: { path: 'src/a\nname.ts', side: 'RIGHT', line: 1 } }), 'invalid-field');
  assertContractError(findingResult({ evidence: '\ud800' }), 'invalid-field');
});

test('enforces the aggregate rendered-text budget at its exact boundary', () => {
  const review = parseReviewResult(aggregateBudgetResult(994));
  assert.equal(review.findings.length, 10);
  assert.equal(MAX_RENDERED_MODEL_TEXT_BYTES, 55_000);
  assertContractError(aggregateBudgetResult(995), 'oversized-output');
});

test('rejects excessive JSON nesting with a contract error before stack exhaustion', () => {
  const atLimit = `${'['.repeat(MAX_JSON_NESTING_DEPTH)}null${']'.repeat(MAX_JSON_NESTING_DEPTH)}`;
  assertContractError(atLimit, 'invalid-shape');

  const deeplyNested = `${'['.repeat(10_000)}null${']'.repeat(10_000)}`;
  assert.ok(Buffer.byteLength(deeplyNested, 'utf8') < MAX_REVIEW_RESULT_BYTES);
  assertContractError(deeplyNested, 'nesting-too-deep');
});

test('rejects a complete assistant payload over the total byte limit', () => {
  assertContractError(' '.repeat(MAX_REVIEW_RESULT_BYTES + 1), 'oversized-output');
});
