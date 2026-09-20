import { renderComment } from './comment';
import type { AuthenticatedActor, GitHubClient, PullRequestContext } from './github';
import { redactReviewSecrets, type ReviewBackend } from './review';
import type { ReviewResultV1 } from './review-contract';

export interface ExecuteAndPublishReviewInput {
  executeReview: () => Promise<ReviewResultV1>;
  client: Pick<GitHubClient, 'upsertManagedComment'>;
  pullRequest: PullRequestContext;
  actor: AuthenticatedActor;
  markers: readonly string[];
  backend: ReviewBackend;
  model: string;
  secrets: readonly string[];
  diffTruncated: boolean;
  originalDiffBytes: number;
}

/** Keeps validation and rendering ahead of the only publication side effect. */
export async function executeAndPublishReview(input: ExecuteAndPublishReviewInput) {
  const marker = input.markers[0];
  if (!marker) throw new Error('At least one managed-comment marker is required');
  const review = await input.executeReview();
  const body = renderComment({
    review: redactReviewSecrets(review, input.secrets),
    backend: input.backend,
    model: input.model,
    headSha: input.pullRequest.headSha,
    actor: input.actor.login,
    diffTruncated: input.diffTruncated,
    originalDiffBytes: input.originalDiffBytes,
    marker,
  });
  return input.client.upsertManagedComment(input.pullRequest, input.actor, input.markers, body);
}
