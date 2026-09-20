import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AuthenticatedActor, GitHubComment, PullRequestContext } from '../src/github';
import { parseReviewResult, type ReviewResultV1 } from '../src/review-contract';
import { executeAndPublishReview } from '../src/review-publication';

const pullRequest: PullRequestContext = {
  owner: 'owner',
  repository: 'repository',
  number: 1,
  title: 'Change',
  body: '',
  baseSha: 'base',
  headSha: '1234567890abcdef',
  author: 'author',
  url: 'https://example.test/pull/1',
};
const actor: AuthenticatedActor = { id: 7, login: 'reviewer' };

function publicationSpy() {
  let calls = 0;
  let publishedBody = '';
  return {
    client: {
      async upsertManagedComment(
        _context: PullRequestContext,
        _actor: AuthenticatedActor,
        _markers: string | readonly string[],
        body: string,
      ): Promise<GitHubComment> {
        calls += 1;
        publishedBody = body;
        return { id: 1, body, html_url: 'https://example.test/comment/1', user: actor };
      },
    },
    calls: () => calls,
    publishedBody: () => publishedBody,
  };
}

function input(executeReview: () => Promise<ReviewResultV1>, spy: ReturnType<typeof publicationSpy>) {
  return {
    executeReview,
    client: spy.client,
    pullRequest,
    actor,
    markers: ['<!-- managed -->'],
    backend: 'opencode' as const,
    model: 'model',
    secrets: ['provider-secret'],
    diffTruncated: false,
    originalDiffBytes: 10,
  };
}

test('malformed backend output cannot reach managed-comment publication', async () => {
  const spy = publicationSpy();
  await assert.rejects(
    executeAndPublishReview(input(async () => parseReviewResult('No material findings.'), spy)),
    /one valid JSON document/,
  );
  assert.equal(spy.calls(), 0);
});

test('a secret in structural review data cannot reach managed-comment publication', async () => {
  const spy = publicationSpy();
  const review = parseReviewResult(
    JSON.stringify({
      version: 1,
      outcome: 'findings',
      findings: [
        {
          category: 'security',
          severity: 'high',
          confidence: 1,
          location: { path: 'src/provider-secret.ts', side: 'RIGHT', line: 1 },
          evidence: 'A credential is exposed.',
          explanation: 'The changed path contains structural secret data.',
          fix: 'Remove the credential.',
        },
      ],
    }),
  );

  await assert.rejects(executeAndPublishReview(input(async () => review, spy)), /forbidden secret data/);
  assert.equal(spy.calls(), 0);
});

test('a valid review is rendered before one managed-comment publication', async () => {
  const spy = publicationSpy();
  const review = parseReviewResult('{"version":1,"outcome":"clean","findings":[]}');

  await executeAndPublishReview(input(async () => review, spy));

  assert.equal(spy.calls(), 1);
  assert.match(spy.publishedBody(), /No material findings\./);
  assert.equal(spy.publishedBody().trimEnd().split(/\r?\n/).at(-1), '<!-- managed -->');
});
