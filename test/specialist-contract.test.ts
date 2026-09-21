import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseArbiterDecision } from '../src/specialist-contract';

const first = `sha256:${'A'.repeat(43)}`;
const second = `sha256:${'B'.repeat(43)}`;

test('parses a strict duplicate-free rejection subset', () => {
  assert.deepEqual(
    parseArbiterDecision(JSON.stringify({ version: 1, rejectedCandidateIds: [second] }), [first, second]),
    {
      version: 1,
      rejectedCandidateIds: [second],
    },
  );
  assert.deepEqual(parseArbiterDecision('{"version":1,"rejectedCandidateIds":[]}', [first]), {
    version: 1,
    rejectedCandidateIds: [],
  });
});

test('rejects malformed, duplicate, unknown, oversized, and mutation-bearing arbiter output', () => {
  for (const raw of [
    'not json',
    '{"version":1,"version":1,"rejectedCandidateIds":[]}',
    '{"version":2,"rejectedCandidateIds":[]}',
    '{"version":1,"rejectedCandidateIds":[],"findings":[]}',
    JSON.stringify({ version: 1, rejectedCandidateIds: [first, first] }),
    JSON.stringify({ version: 1, rejectedCandidateIds: [`sha256:${'Z'.repeat(43)}`] }),
    JSON.stringify({ version: 1, rejectedCandidateIds: Array.from({ length: 11 }, () => first) }),
  ]) {
    assert.throws(() => parseArbiterDecision(raw, [first, second]));
  }
  assert.throws(() => parseArbiterDecision('{"version":1,"rejectedCandidateIds":[]}', [first, first]), /ambiguous/u);
});
