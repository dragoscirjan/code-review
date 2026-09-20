import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_JSON_NESTING_DEPTH } from '../src/review-contract';
import { evaluateRecordedReviewOutputs } from '../src/review-evaluation';

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
  assert.equal(evaluation.results[0]?.review?.outcome, 'clean');
  assert.equal(evaluation.results[1]?.review, undefined);
  assert.equal(evaluation.results[2]?.malformed, true);
});
