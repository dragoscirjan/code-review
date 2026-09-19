import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadActionConfig, MANAGED_COMMENT_MARKER } from "./config";
import { GitHubClient, loadPullRequestEvent } from "./github";
import { runOpenCode } from "./opencode";

function workflowCommandValue(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
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

function renderComment(input: {
  review: string;
  model: string;
  headSha: string;
  actor: string;
  diffTruncated: boolean;
  originalDiffBytes: number;
}): string {
  const truncation = input.diffTruncated
    ? `\n\n> Diff input was truncated from ${input.originalDiffBytes} bytes.`
    : "";
  return `## OpenCode review

- Model: \`${input.model}\`
- Head: \`${input.headSha.slice(0, 12)}\`
- Published through: \`@${input.actor}\`${truncation}

${input.review}

${MANAGED_COMMENT_MARKER}`;
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
    `Reviewing ${pullRequest.owner}/${pullRequest.repository}#${pullRequest.number} at ${pullRequest.headSha.slice(0, 12)}`,
  );
  const [actor, diff] = await Promise.all([
    client.getAuthenticatedActor(),
    client.getPullRequestDiff(pullRequest, config.maxDiffBytes),
  ]);
  console.log(
    `Fetched ${diff.originalBytes} diff bytes${diff.truncated ? `; limited to ${config.maxDiffBytes}` : ""}`,
  );

  const review = await runOpenCode({
    containerEngine: config.containerEngine,
    model: config.model,
    version: config.opencodeVersion,
    customPrompt: config.prompt,
    timeoutMs: config.timeoutMs,
    pullRequest,
    diff,
  });
  const body = renderComment({
    review,
    model: config.model,
    headSha: pullRequest.headSha,
    actor: actor.login,
    diffTruncated: diff.truncated,
    originalDiffBytes: diff.originalBytes,
  });
  const comment = await client.upsertManagedComment(
    pullRequest,
    actor,
    MANAGED_COMMENT_MARKER,
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
