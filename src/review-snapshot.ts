import type { GitHubClient, PullRequestContext, PullRequestDiff, PullRequestRevision } from './github';

function sameRevision(
  expected: Pick<PullRequestRevision, 'baseSha' | 'headSha' | 'changedFiles'>,
  actual: Pick<PullRequestRevision, 'baseSha' | 'headSha' | 'changedFiles'>,
): boolean {
  return (
    expected.baseSha === actual.baseSha &&
    expected.headSha === actual.headSha &&
    expected.changedFiles === actual.changedFiles
  );
}

export interface ReviewedSnapshot {
  revision: PullRequestRevision;
  diff: PullRequestDiff;
}

/** Brackets the unversioned GitHub diff endpoint with revision reads before any model execution. */
export async function acquireReviewedSnapshot(
  client: Pick<GitHubClient, 'getPullRequestRevision' | 'getPullRequestDiff'>,
  pullRequest: PullRequestContext,
  maximumDiffBytes: number,
): Promise<ReviewedSnapshot> {
  const revision = await client.getPullRequestRevision(pullRequest);
  if (revision.baseSha !== pullRequest.baseSha || revision.headSha !== pullRequest.headSha) {
    throw new Error('Pull request revision changed before review');
  }
  const diff = await client.getPullRequestDiff(pullRequest, maximumDiffBytes);
  if (!diff.parsed || diff.totalFiles !== revision.changedFiles) {
    throw new Error('GitHub diff does not contain the complete changed-file set');
  }
  const after = await client.getPullRequestRevision(pullRequest);
  if (!sameRevision(revision, after)) throw new Error('Pull request revision changed during diff acquisition');
  return { revision, diff };
}

export async function assertSnapshotFresh(
  client: Pick<GitHubClient, 'getPullRequestRevision'>,
  pullRequest: PullRequestContext,
  revision: PullRequestRevision,
): Promise<void> {
  if (!sameRevision(revision, await client.getPullRequestRevision(pullRequest))) {
    throw new Error('Pull request revision changed during review');
  }
}
