import type { GitHubClient, PullRequestContext, PullRequestDiff, PullRequestRevision } from './github';

export const SNAPSHOT_METADATA_TIMEOUT_MS = 15_000;
export const SNAPSHOT_DIFF_TIMEOUT_MS = 30_000;

/** Fields that identify the exact reviewed revision; metadata prose is untrusted data, not identity. */
function sameRevisionIdentity(expected: PullRequestRevision, actual: PullRequestRevision): boolean {
  return (
    expected.baseSha === actual.baseSha &&
    expected.headSha === actual.headSha &&
    expected.changedFiles === actual.changedFiles
  );
}

function sameRevision(expected: PullRequestRevision, actual: PullRequestRevision): boolean {
  return (
    sameRevisionIdentity(expected, actual) &&
    expected.title === actual.title &&
    expected.body === actual.body &&
    expected.author === actual.author
  );
}

export interface ReviewedSnapshot {
  revision: PullRequestRevision;
  pullRequest: PullRequestContext;
  diff: PullRequestDiff & Required<Pick<PullRequestDiff, 'parsed' | 'completeParsed' | 'totalFiles'>>;
}

/** Brackets the unversioned GitHub diff endpoint with revision reads before any model execution. */
export async function acquireReviewedSnapshot(
  client: Pick<GitHubClient, 'getPullRequestRevision' | 'getPullRequestDiff'>,
  pullRequest: PullRequestContext,
  maximumDiffBytes: number,
): Promise<ReviewedSnapshot> {
  const revision = await client.getPullRequestRevision(pullRequest, AbortSignal.timeout(SNAPSHOT_METADATA_TIMEOUT_MS));
  if (revision.baseSha !== pullRequest.baseSha || revision.headSha !== pullRequest.headSha) {
    throw new Error('Pull request revision changed before review');
  }
  const diff = await client.getPullRequestDiff(
    pullRequest,
    maximumDiffBytes,
    AbortSignal.timeout(SNAPSHOT_DIFF_TIMEOUT_MS),
  );
  if (!diff.parsed || !diff.completeParsed || diff.totalFiles !== revision.changedFiles) {
    throw new Error('GitHub diff does not contain the complete changed-file set');
  }
  const after = await client.getPullRequestRevision(pullRequest, AbortSignal.timeout(SNAPSHOT_METADATA_TIMEOUT_MS));
  if (!sameRevision(revision, after)) throw new Error('Pull request revision changed during diff acquisition');
  return {
    revision,
    pullRequest: {
      ...pullRequest,
      title: revision.title,
      body: revision.body,
      author: revision.author,
      baseSha: revision.baseSha,
      headSha: revision.headSha,
    },
    diff: diff as PullRequestDiff & Required<Pick<PullRequestDiff, 'parsed' | 'completeParsed' | 'totalFiles'>>,
  };
}

/**
 * Long-window freshness check used between setup phases and before each publication write. Only
 * revision identity (base, head, changed-file count) fails the run. Title, body, and author edits
 * that happen while a slow indexer or backend executes must not abort an otherwise-valid review of
 * the same head revision; the snapshot's captured metadata stays the untrusted prompt data.
 */
export async function assertSnapshotFresh(
  client: Pick<GitHubClient, 'getPullRequestRevision'>,
  pullRequest: PullRequestContext,
  revision: PullRequestRevision,
): Promise<void> {
  if (
    !sameRevisionIdentity(
      revision,
      await client.getPullRequestRevision(pullRequest, AbortSignal.timeout(SNAPSHOT_METADATA_TIMEOUT_MS)),
    )
  ) {
    throw new Error('Pull request revision changed during review');
  }
}
