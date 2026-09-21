import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { main } from '../src/review-evaluation-cli';

const enabled = process.env.RUN_LLM_EVALUATION === '1';

test('runs the opt-in provider-neutral live evaluation corpus', { skip: !enabled, timeout: 30 * 60_000 }, async () => {
  assert.ok(process.env.REVIEW_EVALUATION_MODEL_CONFIG, 'REVIEW_EVALUATION_MODEL_CONFIG is required');
  const root = await mkdtemp(join(tmpdir(), 'code-review-live-evaluation-'));
  try {
    const output = join(root, 'reports');
    const result = await main(['--live'], {
      ...process.env,
      RUNNER_TEMP: root,
      REVIEW_EVALUATION_OUTPUT_DIR: output,
    });
    assert.equal(result, 0);
    const report = JSON.parse(await readFile(join(output, 'review-evaluation.json'), 'utf8')) as {
      run: { mode: string };
      metrics: { totalRuns: number };
    };
    assert.equal(report.run.mode, 'live');
    assert.ok(report.metrics.totalRuns > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
