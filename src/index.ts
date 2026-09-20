import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { renderComment } from "./comment";
import { loadActionConfig, managedCommentMarker } from "./config";
import { GitHubClient, loadPullRequestEvent } from "./github";
import { runReview } from "./review";

function workflowCommandValue(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

async function setOutput(name: string, value: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const delimiter = `code_review_${randomUUID()}`;
  await appendFile(
    outputPath,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  const config = loadActionConfig();
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }

  const pullRequest = await loadPullRequestEvent(eventPath);
  const client = new GitHubClient(
    config.githubToken,
    process.env.GITHUB_API_URL ?? "https://api.github.com",
  );

  console.log(
    `Reviewing ${pullRequest.owner}/${pullRequest.repository}#${pullRequest.number} at ${pullRequest.headSha.slice(0, 12)} with ${config.backend}`,
  );
  const [actor, diff] = await Promise.all([
    client.getAuthenticatedActor(),
    client.getPullRequestDiff(pullRequest, config.maxDiffBytes),
  ]);
  console.log(
    `Fetched ${diff.originalBytes} diff bytes${diff.truncated ? `; limited to ${config.maxDiffBytes}` : ""}`,
  );

  const review = await runReview({
    backend: config.backend,
    containerEngine: config.containerEngine,
    model: config.model,
    openRouterApiKey: config.openRouterApiKey,
    opencodeVersion: config.opencodeVersion,
    piVersion: config.piVersion,
    customPrompt: config.prompt,
    timeoutMs: config.timeoutMs,
    pullRequest,
    diff,
  });
  const marker = managedCommentMarker(config.backend);
  const body = renderComment({
    review,
    backend: config.backend,
    model: config.model,
    headSha: pullRequest.headSha,
    actor: actor.login,
    diffTruncated: diff.truncated,
    originalDiffBytes: diff.originalBytes,
    marker,
  });
  const comment = await client.upsertManagedComment(
    pullRequest,
    actor,
    marker,
    body,
  );

  await setOutput("comment-url", comment.html_url);
  await setOutput("diff-truncated", String(diff.truncated));
  console.log(`Published review: ${comment.html_url}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${workflowCommandValue(message)}`);
  process.exitCode = 1;
});
