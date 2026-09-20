import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildPiCommand, extractPiAssistantText } from '../src/pi';

test('extracts the final assistant text from Pi JSON output', () => {
  const output = [
    'npx informational notice',
    JSON.stringify({ type: 'session', version: 3 }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          { type: 'thinking', thinking: 'private' },
          { type: 'text', text: 'Pi review' },
        ],
      },
    }),
  ].join('\n');
  assert.equal(extractPiAssistantText(output), 'Pi review');
});

test('preserves a JSON contract split across assistant text parts', () => {
  const output = JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [
        { type: 'text', text: '{"version":1,' },
        { type: 'text', text: '"outcome":"clean","findings":[]}' },
      ],
    },
  });
  assert.equal(extractPiAssistantText(output), '{"version":1,"outcome":"clean","findings":[]}');
});

test('rejects output without review text', () => {
  assert.throws(() => extractPiAssistantText('not json'), /no review text/);
  assert.throws(() => extractPiAssistantText(JSON.stringify({ type: 'agent_end' })), /no review text/);
});

test('surfaces Pi provider errors', () => {
  assert.throws(
    () =>
      extractPiAssistantText(
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'provider failed',
            content: [],
          },
        }),
      ),
    /provider error; backend details suppressed/,
  );
});

test('builds a tool-free Pi command for the configured provider', () => {
  const command = buildPiCommand({
    version: '0.85.1',
    model: 'z-ai/glm-5.3-flash',
  });
  assert.deepEqual(command.slice(0, 3), ['npx', '--yes', '@earendil-works/pi-coding-agent@0.85.1']);
  assert.ok(command.includes('--no-tools'));
  assert.ok(command.includes('--no-extensions'));
  assert.ok(command.includes('--no-context-files'));
  assert.ok(command.includes('review-provider'));
  assert.ok(command.includes('z-ai/glm-5.3-flash'));
  assert.ok(command.includes('--offline'));
});
