import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_SHARD_FILES, splitDiffShards } from '../src/review-shards';
import { prepareReviewedDiff } from '../src/unified-diff';

function fileSection(path: string, additions: number, startLine = 0): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${startLine},${startLine > 0 ? additions : 0} +${startLine + 1},${additions} @@`,
    ...Array.from({ length: additions }, (_, index) => `+const value${index} = ${index};`),
  ];
}

test('clusters small files into bounded whole-file shards', () => {
  const diff = prepareReviewedDiff(
    Array.from({ length: 9 }, (_, index) => fileSection(`src/small${index}.ts`, 2).join('\n')).join('\n'),
    500_000,
  );
  const { shards, leftoverShard } = splitDiffShards(diff);
  assert.equal(leftoverShard, null);
  assert.equal(shards.length, 3);
  for (const shard of shards) {
    assert.ok(shard.paths.length <= MAX_SHARD_FILES);
    const parsed = prepareReviewedDiff(shard.text, 1_000_000);
    assert.equal(parsed.truncated, false);
    assert.equal(parsed.parsed.files.length, shard.paths.length);
    assert.deepEqual(
      [...new Set(shard.paths)].sort(),
      [...new Set(parsed.parsed.files.flatMap((file) => [file.oldPath, file.apiPath]))].sort(),
    );
  }
  const covered = new Set(shards.flatMap((shard) => shard.paths));
  assert.equal(covered.size, 9);
});

test('splits oversized files at hunk boundaries and keeps every hunk covered exactly once', () => {
  // Three ~430-byte hunks in one file exceed the cap together but fit pairwise, so hunk-boundary
  // splitting must produce several shards without cutting inside a hunk.
  const hunk = (newStart: number): string[] => [
    `@@ -0,0 +${newStart},20 @@`,
    ...Array.from({ length: 20 }, (_, index) => `+value${newStart + index - 1} = ${index};`),
  ];
  const bigTwo = [
    'diff --git a/src/big-two.ts b/src/big-two.ts',
    '--- a/src/big-two.ts',
    '+++ b/src/big-two.ts',
    ...hunk(1),
    ...hunk(41),
    ...hunk(81),
  ];
  const diff = prepareReviewedDiff([...fileSection('src/big-one.ts', 2), ...bigTwo].join('\n'), 500_000);
  const { shards, leftoverShard } = splitDiffShards(diff, 1_000);
  assert.equal(leftoverShard, null);
  assert.ok(shards.length > 1);
  const seenHunks = shards.flatMap((shard) =>
    prepareReviewedDiff(shard.text, 1_000_000)
      .parsed.files.flatMap((file) => file.hunks)
      .map((hunk) => `${hunk.oldStart}:${hunk.newStart}:${hunk.rawLines.length}`),
  );
  assert.equal(new Set(seenHunks).size, seenHunks.length);
  for (const shard of shards.filter((entry) => entry.paths.includes('src/big-two.ts'))) {
    assert.ok(Buffer.byteLength(shard.text, 'utf8') <= 1_000);
    assert.deepEqual([...new Set(shard.paths)], ['src/big-two.ts']);
  }
  const totalAdditions = shards.reduce(
    (total, shard) =>
      total +
      (prepareReviewedDiff(shard.text, 1_000_000).parsed.files[0]?.hunks ?? []).reduce(
        (sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'addition').length,
        0,
      ),
    0,
  );
  assert.equal(totalAdditions, 62);
});

test('builds a leftover shard for files dropped by diff truncation and oversized single hunks', () => {
  // One commentable file inside the parsed diff, one metadata-only file, and one oversized hunk.
  const oversized = fileSection('src/too-big.ts', 40);
  const diff = prepareReviewedDiff([...fileSection('src/kept.ts', 2), ...oversized].join('\n'), 500_000);
  const { shards, leftoverShard } = splitDiffShards(diff, 300);
  assert.equal(shards.length, 1);
  assert.deepEqual(shards[0]?.paths, ['src/kept.ts']);
  assert.ok(leftoverShard);
  assert.equal(leftoverShard?.paths.includes('src/too-big.ts'), true);
  const parsed = prepareReviewedDiff(leftoverShard?.text ?? '', 1_000_000);
  assert.equal(parsed.parsed.files[0]?.apiPath, 'src/too-big.ts');
  assert.ok(parsed.parsed.files[0]?.commentable);
});

test('leftover shard stays within the model-visible diff budget and preserves exact hunks', () => {
  const oversized = fileSection('src/too-big.ts', 40);
  const diff = prepareReviewedDiff(oversized.join('\n'), 500_000);
  const { shards, leftoverShard } = splitDiffShards(diff, 300);
  assert.equal(shards.length, 0);
  assert.ok(leftoverShard);
  assert.deepEqual(leftoverShard?.paths, ['src/too-big.ts']);
  const parsed = prepareReviewedDiff(leftoverShard?.text ?? '', 1_000_000);
  assert.equal(parsed.parsed.files[0]?.apiPath, 'src/too-big.ts');
  assert.equal(
    parsed.parsed.files[0]?.hunks.reduce(
      (sum, hunk) => sum + hunk.lines.filter((line) => line.kind === 'addition').length,
      0,
    ),
    40,
  );
});
