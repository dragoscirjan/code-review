import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_PROGRESS_LOG_LINES, createReviewProgressLogger, type ReviewProgressEvent } from '../src/review-progress';

function events(): ReviewProgressEvent[] {
  return [
    { phase: 'review-started' },
    { phase: 'shard-queued', shardIndex: 0, totalShards: 3 },
    { phase: 'shard-started', shardIndex: 0, totalShards: 3 },
    { phase: 'shard-completed', shardIndex: 0, totalShards: 3, findings: 2 },
    { phase: 'shard-skipped', shardIndex: 1, totalShards: 3, degraded: true },
    { phase: 'merge-pass-started' },
    { phase: 'review-completed' },
  ];
}

test('shard lifecycle events emit bounded log lines with shard index and elapsed time', () => {
  const lines: string[] = [];
  const logger = createReviewProgressLogger({ secrets: [], sink: (line) => lines.push(line) });
  for (const event of events()) logger.event(event);
  assert.equal(lines.length, 7);
  assert.match(lines[0], /\[review-progress v1\] \+0\.0s phase=review-started/u);
  assert.match(lines[1], /phase=shard-queued shard=0\/3/u);
  assert.match(lines[2], /phase=shard-started shard=0\/3/u);
  assert.match(lines[3], /phase=shard-completed shard=0\/3 findings=2/u);
  assert.match(lines[4], /phase=shard-skipped shard=1\/3 degraded=true/u);
  assert.match(lines[5], /phase=merge-pass-started/u);
  assert.match(lines[6], /phase=review-completed/u);
  // Elapsed time is always present and monotonic.
  const elapsed = lines.map((line) => Number(/ \+([\d.]+)s /.exec(`${line} `)?.[1]));
  assert.ok(elapsed.every((value) => Number.isFinite(value) && value >= 0));
});

test('the log line count is capped and overflow events are counted as suppressed', () => {
  const lines: string[] = [];
  const logger = createReviewProgressLogger({ secrets: [], sink: (line) => lines.push(line) });
  for (let index = 0; index < MAX_PROGRESS_LOG_LINES + 25; index += 1) {
    logger.event({ phase: 'shard-completed', shardIndex: index, totalShards: 999, findings: 1 });
  }
  assert.equal(lines.length, MAX_PROGRESS_LOG_LINES);
  assert.equal(logger.emitted(), MAX_PROGRESS_LOG_LINES);
  assert.equal(logger.suppressed(), 25);
});

test('progress lines carry only fixed status words, numbers, and timings — never secrets or PR content', () => {
  const lines: string[] = [];
  const logger = createReviewProgressLogger({
    secrets: ['provider-secret-token', '["quoted"]'],
    sink: (line) => lines.push(line),
  });
  for (const event of events()) logger.event(event);
  assert.ok(lines.length > 0);
  const linePattern =
    /^\[review-progress v\d\] \+[\d.]+s phase=[a-z-]+(?: shard=\d+\/(?:\d+|\?))?(?: findings=\d+)?(?: degraded=true)?$/u;
  for (const line of lines) {
    assert.ok(!line.includes('provider-secret-token'));
    assert.ok(!line.includes('quoted'));
    assert.match(line, linePattern);
  }
});
