import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PullRequestContext, PullRequestRevision } from '../src/github';
import { acquireReviewedSnapshot, assertSnapshotFresh } from '../src/review-snapshot';
import { prepareReviewedDiff } from '../src/unified-diff';

const pullRequest: PullRequestContext = {
  owner: 'owner',
  repository: 'repository',
  number: 1,
  title: 'Change',
  body: '',
  baseSha: 'base',
  headSha: 'head',
  author: 'author',
  url: 'https://example.test/1',
};
const diff = prepareReviewedDiff(
  ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
  10_000,
);
const revision: PullRequestRevision = {
  baseSha: 'base',
  headSha: 'head',
  changedFiles: 1,
  title: 'Change',
  body: '',
  author: 'author',
};

test('acquires a diff only when event, before, and after revisions agree', async () => {
  let revisionReads = 0;
  const result = await acquireReviewedSnapshot(
    {
      async getPullRequestRevision(_context, signal) {
        assert.equal(signal instanceof AbortSignal, true);
        revisionReads += 1;
        return revision;
      },
      async getPullRequestDiff(_context, _maximumBytes, signal) {
        assert.equal(signal instanceof AbortSignal, true);
        return diff;
      },
    },
    pullRequest,
    10_000,
  );
  assert.equal(revisionReads, 2);
  assert.equal(result.diff.text, diff.text);
});

test('rejects a stale event before fetching the diff', async () => {
  let diffCalls = 0;
  await assert.rejects(
    acquireReviewedSnapshot(
      {
        async getPullRequestRevision() {
          return { ...revision, headSha: 'replacement' };
        },
        async getPullRequestDiff() {
          diffCalls += 1;
          return diff;
        },
      },
      pullRequest,
      10_000,
    ),
    /changed before review/,
  );
  assert.equal(diffCalls, 0);
});

test('rejects a force-push or changed-file race around diff acquisition', async () => {
  const revisions = [revision, { ...revision, headSha: 'replacement' }];
  await assert.rejects(
    acquireReviewedSnapshot(
      {
        async getPullRequestRevision() {
          const current = revisions.shift();
          assert.ok(current);
          return current;
        },
        async getPullRequestDiff() {
          return diff;
        },
      },
      pullRequest,
      10_000,
    ),
    /during diff acquisition/,
  );
});

test('rejects an incomplete GitHub changed-file set', async () => {
  await assert.rejects(
    acquireReviewedSnapshot(
      {
        async getPullRequestRevision() {
          return { ...revision, changedFiles: 2 };
        },
        async getPullRequestDiff() {
          return diff;
        },
      },
      pullRequest,
      10_000,
    ),
    /complete changed-file set/,
  );
});

test('final freshness check rejects changed revision or mutable pull request metadata', async () => {
  for (const changed of [
    { ...revision, headSha: 'replacement' },
    { ...revision, baseSha: 'replacement' },
    { ...revision, changedFiles: 2 },
    { ...revision, title: 'Replacement title' },
    { ...revision, body: 'Replacement body' },
    { ...revision, author: 'replacement-author' },
  ]) {
    await assert.rejects(
      assertSnapshotFresh(
        {
          async getPullRequestRevision() {
            return changed;
          },
        },
        pullRequest,
        revision,
      ),
      /changed during review/,
    );
  }
});
