import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { main } from '../src/review-evaluation-cli';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('recorded CLI writes only fixed bounded reports under trusted temporary storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-evaluation-cli-test-'));
  roots.push(root);
  const output = join(root, 'reports');
  const exit = await main(['--check'], { RUNNER_TEMP: root, REVIEW_EVALUATION_OUTPUT_DIR: output });
  assert.equal(exit, 0);
  const json = JSON.parse(await readFile(join(output, 'review-evaluation.json'), 'utf8')) as {
    run: { mode: string };
    thresholdFailures: string[];
  };
  assert.equal(json.run.mode, 'recorded');
  assert.deepEqual(json.thresholdFailures, []);
  assert.match(await readFile(join(output, 'review-evaluation.md'), 'utf8'), /Thresholds: \*\*passed\*\*/u);
});

test('live CLI is doubly opt-in and credential/config failures create no artifacts or network calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-review-evaluation-live-test-'));
  roots.push(root);
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error('network must remain unused');
  }) as typeof fetch;
  try {
    await assert.rejects(main(['--live'], { RUNNER_TEMP: root }), /RUN_LLM_EVALUATION/);
    await assert.rejects(
      main(['--live'], {
        RUNNER_TEMP: root,
        RUN_LLM_EVALUATION: '1',
        REVIEW_EVALUATION_MODEL_CONFIG: JSON.stringify({
          version: 1,
          provider: {
            api: 'openai-completions',
            baseUrl: 'https://models.example.invalid/v1',
            network: 'remote',
            credential: 'selected',
          },
          model: { id: 'fixture-model', contextWindow: 8192, maxOutputTokens: 1024 },
        }),
        REVIEW_EVALUATION_MODEL_CREDENTIALS: JSON.stringify({
          unused: { type: 'bearer', value: 'synthetic-secret-value' },
        }),
      }),
      /Selected provider credential is missing/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
