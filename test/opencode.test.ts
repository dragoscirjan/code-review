import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildOpenCodeCommand, extractOpenCodeAssistantText } from '../src/opencode';

test('extracts text events from OpenCode JSON output', () => {
  const output = [
    'npx informational notice',
    JSON.stringify({ type: 'step_start' }),
    JSON.stringify({ type: 'text', part: { text: 'First' } }),
    JSON.stringify({ type: 'text', part: { text: 'Second' } }),
  ].join('\n');
  assert.equal(extractOpenCodeAssistantText(output), 'FirstSecond');
});

test('preserves a JSON contract split across text events', () => {
  const output = [
    JSON.stringify({ type: 'text', part: { text: '{"version":1,' } }),
    JSON.stringify({ type: 'text', part: { text: '"outcome":"clean","findings":[]}' } }),
  ].join('\n');
  assert.equal(extractOpenCodeAssistantText(output), '{"version":1,"outcome":"clean","findings":[]}');
});

test('rejects output without review text', () => {
  assert.throws(() => extractOpenCodeAssistantText('not json'), /no review text/);
  assert.throws(() => extractOpenCodeAssistantText(JSON.stringify({ type: 'step_finish' })), /no review text/);
});

test('builds a pure OpenCode command for only the configured model', () => {
  const command = buildOpenCodeCommand({
    version: '1.18.31',
  });
  assert.deepEqual(command.slice(0, 3), ['npx', '--yes', 'opencode-ai@1.18.31']);
  assert.ok(command.includes('--pure'));
  assert.ok(command.includes('review-provider/review-model'));
});
